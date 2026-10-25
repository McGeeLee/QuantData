import type {
  DataSource,
  Locale,
  MarketBar,
  MarketDataResponse,
  MarketQuery,
  MarketSnapshot,
  SourceStatus,
} from "../domain/types";
import { MarketBarSchema } from "../domain/types";
import { z } from "zod";
import type { RuntimeEnv } from "../env";
import { AppError } from "../lib/app-error";
import { disclaimer, warningText } from "../lib/i18n";
import { getProvider } from "../providers";
import { createBudgetedFetch } from "../lib/budgeted-fetch";

const CACHE_TTL = 3_600;

type ServiceEnv = Pick<RuntimeEnv, "MARKET_RATE_LIMIT" | "TUSHARE_TOKEN" | "TIINGO_KEY" | "PROVIDER_BUDGET">;

type CachedPayload = {
  bars: MarketBar[];
  fetchedAt: string;
};

const CachedPayloadSchema = z.object({
  bars: z.array(MarketBarSchema).min(1),
  fetchedAt: z.string().datetime(),
});

type ServiceOptions = {
  maxBars?: number;
  cache?: Cache | null;
  fetcher?: typeof fetch;
  executionCtx?: ExecutionContext;
};

function providerContext(env: ServiceEnv, query: MarketQuery, fetcher?: typeof fetch) {
  return {
    tushareToken: env.TUSHARE_TOKEN,
    tiingoKey: env.TIINGO_KEY,
    fetcher: createBudgetedFetch(env, query.source, query.symbol, fetcher),
  };
}

export function buildCacheKey(query: MarketQuery): Request {
  // Internal normalization version; v2 uses Yahoo exchange-local trading dates.
  // Keep this separate from the public /api/v1 contract and its older caches.
  const url = new URL("https://quant-data-cache.internal/v2/market-data");
  url.search = new URLSearchParams({
    source: query.source,
    symbol: query.symbol.toUpperCase(),
    start: query.start,
    end: query.end,
    interval: "1d",
  }).toString();
  return new Request(url, { method: "GET" });
}

function sourceWarnings(source: DataSource, locale: Locale): string[] {
  const warnings = [warningText(locale, "raw")];
  if (source === "yahoo") warnings.unshift(warningText(locale, "yahoo"));
  if (source === "tiingo") warnings.unshift(warningText(locale, "tiingo"));
  return warnings;
}

function attribution(source: DataSource): string | undefined {
  if (source === "tiingo") return "Data provided by Tiingo (https://www.tiingo.com/)";
  return source === "tushare" ? "Data provided by Tushare (https://tushare.pro/)" : undefined;
}

function volumeUnit(source: DataSource): string {
  return source === "tushare" ? "lots (100 shares per lot)" : "provider-native units";
}

async function defaultCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open("quant-data-v1");
  } catch {
    return null;
  }
}

async function readCached(cache: Cache | null, key: Request): Promise<CachedPayload | null> {
  if (!cache) return null;
  const hit = await cache.match(key);
  if (!hit) return null;
  try {
    const parsed = CachedPayloadSchema.safeParse(await hit.json());
    if (!parsed.success) return null;
    const age = Date.now() - Date.parse(parsed.data.fetchedAt);
    if (age < 0 || age >= CACHE_TTL * 1_000) return null;
    if (parsed.data.bars.some((bar, index, bars) => index > 0 && bars[index - 1].date >= bar.date)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function enforceRateLimit(env: ServiceEnv, request: Request, source: DataSource): Promise<void> {
  const client = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "anonymous";
  const result = await env.MARKET_RATE_LIMIT.limit({ key: `${client}:${source}` });
  if (!result.success) throw new AppError("RATE_LIMITED", 429, { retryAfterSeconds: 60 });
}

export function listSources(env: ServiceEnv, locale: Locale): { sources: SourceStatus[]; disclaimer: string } {
  return {
    sources: [
      {
        id: "yahoo",
        name: "Yahoo Finance Chart",
        configured: true,
        official: false,
        markets: ["US equities", "crypto", "selected global markets"],
        symbolExamples: ["AAPL", "BTC-USD", "600519.SS"],
        warnings: [warningText(locale, "yahoo")],
      },
      {
        id: "tushare",
        name: "Tushare Pro",
        configured: Boolean(env.TUSHARE_TOKEN),
        official: true,
        markets: ["China A-shares"],
        symbolExamples: ["600519.SH", "000001.SZ"],
        attribution: "Data provided by Tushare (https://tushare.pro/)",
        warnings: [],
      },
      {
        id: "tiingo",
        name: "Tiingo",
        configured: Boolean(env.TIINGO_KEY),
        official: true,
        markets: ["US equities"],
        symbolExamples: ["AAPL", "TSLA"],
        attribution: "Data provided by Tiingo (https://www.tiingo.com/)",
        warnings: [warningText(locale, "tiingo")],
      },
    ],
    disclaimer: disclaimer[locale],
  };
}

export async function getMarketData(
  env: ServiceEnv,
  query: MarketQuery,
  locale: Locale,
  options: ServiceOptions = {},
): Promise<MarketDataResponse> {
  // Removing a provider credential must disable it even when old data is cached.
  if ((query.source === "tushare" && !env.TUSHARE_TOKEN) || (query.source === "tiingo" && !env.TIINGO_KEY)) {
    throw new AppError("SOURCE_NOT_CONFIGURED", 503);
  }
  const maxBars = options.maxBars ?? 2_000;
  let cache = options.cache === undefined ? await defaultCache() : options.cache;
  const key = buildCacheKey(query);
  let cached: CachedPayload | null = null;
  try {
    cached = await readCached(cache, key);
  } catch {
    // Cache infrastructure is optional; provider reads still work when it fails.
    cache = null;
  }
  if (cached?.bars.some((bar) => bar.date < query.start || bar.date > query.end)) cached = null;
  const cacheStatus = cached ? "hit" : cache ? "miss" : "unavailable";

  if (!cached) {
    const providerBars = await getProvider(query.source).fetch(query, providerContext(env, query, options.fetcher));
    const bars = providerBars.filter((bar) => bar.date >= query.start && bar.date <= query.end);
    if (bars.length === 0) throw new AppError("NOT_FOUND", 404);
    cached = { bars, fetchedAt: new Date().toISOString() };
    if (cache) {
      const response = new Response(JSON.stringify(cached), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${CACHE_TTL}`,
        },
      });
      const write = cache.put(key, response).catch((error: unknown) => {
        console.error(JSON.stringify({ event: "cache_write_error", name: error instanceof Error ? error.name : "UnknownError" }));
      });
      if (options.executionCtx) options.executionCtx.waitUntil(write);
      else await write;
    }
  }

  const truncated = cached.bars.length > maxBars;
  const bars = truncated ? cached.bars.slice(-maxBars) : cached.bars;
  return {
    meta: {
      source: query.source,
      symbol: query.symbol,
      interval: "1d",
      adjustment: "raw",
      volumeUnit: volumeUnit(query.source),
      count: bars.length,
      fetchedAt: cached.fetchedAt,
      latestBarDate: bars[bars.length - 1].date,
      cache: {
        status: cacheStatus,
        ttlSeconds: CACHE_TTL,
        ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(cached.fetchedAt)) / 1_000)),
      },
      truncated,
      attribution: attribution(query.source),
      warnings: [...sourceWarnings(query.source, locale), disclaimer[locale]],
    },
    bars,
  };
}

export async function getMarketSnapshot(
  env: ServiceEnv,
  query: MarketQuery,
  locale: Locale,
  options: ServiceOptions = {},
): Promise<MarketSnapshot> {
  const data = await getMarketData(env, query, locale, { ...options, maxBars: 2 });
  const latest = data.bars.at(-1);
  if (!latest) throw new AppError("NOT_FOUND", 404);
  const previous = data.bars.at(-2);
  const change = previous ? latest.close - previous.close : null;
  const changePercent = previous && change !== null && previous.close !== 0 ? (change / previous.close) * 100 : null;
  return {
    meta: data.meta,
    snapshot: {
      date: latest.date,
      close: latest.close,
      previousClose: previous?.close ?? null,
      change,
      changePercent,
      volume: latest.volume,
    },
  };
}
