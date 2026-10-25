import { ConnectionCheckSchema, type ConnectionCheck } from "../domain/connectivity";
import type { DataSource, MarketQuery } from "../domain/types";
import type { RuntimeEnv } from "../env";
import { AppError, retryAfterSeconds } from "../lib/app-error";
import { defaultDateRange } from "../lib/dates";
import { getProvider } from "../providers";
import { createBudgetedFetch } from "../lib/budgeted-fetch";

const CHECK_TTL_SECONDS = 300;
const SAMPLE_SYMBOLS = { yahoo: "AAPL", tushare: "600519.SH", tiingo: "AAPL" } satisfies Record<DataSource, string>;
type CheckEnv = Pick<RuntimeEnv, "SOURCE_CHECK_RATE_LIMIT" | "VERSION_METADATA" | "TUSHARE_TOKEN" | "TIINGO_KEY" | "PROVIDER_BUDGET">;
type CheckOptions = {
  requestId: string;
  executionCtx?: ExecutionContext;
  fetcher?: typeof fetch;
  cache?: Cache | null;
  now?: Date;
};

export function buildConnectionCacheKey(source: DataSource, versionId: string): Request {
  const url = new URL(`https://quant-data-cache.internal/connectivity/v1/${source}`);
  // A Worker secret update creates a new version; never put credentials in keys.
  url.searchParams.set("version", versionId);
  return new Request(url);
}

function sampleQuery(source: DataSource, now: Date): MarketQuery {
  return { source, symbol: SAMPLE_SYMBOLS[source], ...defaultDateRange(now) };
}

async function diagnosticCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open("quant-data-connectivity-v1");
  } catch {
    return null;
  }
}

async function cachedCheck(cache: Cache | null, key: Request, source: DataSource, now: Date): Promise<ConnectionCheck | null> {
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    if (!hit) return null;
    const parsed = ConnectionCheckSchema.safeParse(await hit.json());
    if (!parsed.success) return null;
    const check = parsed.data;
    const checkedAt = Date.parse(check.checkedAt);
    const nextCheckAt = Date.parse(check.nextCheckAt);
    if (check.source !== source || check.cached || checkedAt > now.getTime() || nextCheckAt <= now.getTime()) return null;
    const lifetime = nextCheckAt - checkedAt;
    // Longer reuse is reserved for an upstream Retry-After, never success data.
    if (lifetime < CHECK_TTL_SECONDS * 1_000 || (!["rate_limited", "quota_exceeded"].includes(check.status) && lifetime !== CHECK_TTL_SECONDS * 1_000)) return null;
    const expected = sampleQuery(source, new Date(checkedAt));
    if (check.sample.symbol !== expected.symbol || check.sample.start !== expected.start || check.sample.end !== expected.end) return null;
    if (check.sample.latestBarDate && (check.sample.latestBarDate < expected.start || check.sample.latestBarDate > expected.end)) return null;
    if (check.status === "ok" && (!check.sample.barCount || !check.sample.latestBarDate || check.error)) return null;
    return check;
  } catch {
    return null;
  }
}

function safeNumericDetail(error: AppError, field: "upstreamStatus" | "providerCode"): number | undefined {
  if (typeof error.details !== "object" || error.details === null || !(field in error.details)) return undefined;
  const value: unknown = error.details[field as keyof typeof error.details];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (field === "upstreamStatus" && (!Number.isInteger(value) || value < 100 || value > 599)) return undefined;
  return value;
}

function failure(error: unknown): { status: ConnectionCheck["status"]; error: NonNullable<ConnectionCheck["error"]>; retrySeconds: number } {
  if (!(error instanceof AppError)) return { status: "upstream_error", error: { code: "UPSTREAM_ERROR" }, retrySeconds: 0 };
  const upstreamStatus = safeNumericDetail(error, "upstreamStatus");
  const providerCode = safeNumericDetail(error, "providerCode");
  const code = error.code;
  let status: ConnectionCheck["status"] = "upstream_error";
  if (code === "SOURCE_NOT_CONFIGURED") status = "not_configured";
  else if (code === "QUOTA_EXCEEDED") status = "quota_exceeded";
  else if (code === "QUOTA_UNAVAILABLE") status = "quota_unavailable";
  else if (upstreamStatus === 401 || upstreamStatus === 403) status = "access_denied";
  else if (code === "UPSTREAM_RATE_LIMITED") status = "rate_limited";
  else if (code === "UPSTREAM_TIMEOUT") status = "timeout";
  else if (code === "NOT_FOUND") status = "no_data";
  else if (typeof error.details === "object" && error.details !== null && "reason" in error.details && error.details.reason === "network_error") status = "network_error";
  return { status, error: { code, ...(upstreamStatus === undefined ? {} : { upstreamStatus }), ...(providerCode === undefined ? {} : { providerCode }) }, retrySeconds: retryAfterSeconds(error) ?? 0 };
}

/** Explicit diagnostic only: callers must never invoke this during source listing. */
export async function checkSourceConnection(env: CheckEnv, source: DataSource, options: CheckOptions): Promise<ConnectionCheck> {
  const now = options.now ?? new Date();
  const query = sampleQuery(source, now);
  const { symbol, start, end } = query;
  const base = {
    source, checkedAt: now.toISOString(), durationMs: 0, cached: false,
    nextCheckAt: new Date(now.getTime() + CHECK_TTL_SECONDS * 1_000).toISOString(),
    sample: { symbol, start, end }, requestId: options.requestId,
  };
  // An absent credential must not be hidden by a previously successful check.
  if ((source === "tushare" && !env.TUSHARE_TOKEN) || (source === "tiingo" && !env.TIINGO_KEY)) {
    return { ...base, status: "not_configured", error: { code: "SOURCE_NOT_CONFIGURED" } };
  }
  const cache = env.VERSION_METADATA.id ? (options.cache === undefined ? await diagnosticCache() : options.cache) : null;
  const key = buildConnectionCacheKey(source, env.VERSION_METADATA.id);
  const previous = await cachedCheck(cache, key, source, now);
  if (previous) return { ...previous, cached: true, requestId: options.requestId };

  // Cache failure must not turn the public diagnostic into unlimited probes.
  // Cloudflare's limiter is per location, not a globally coordinated quota.
  let allowed: boolean;
  try {
    allowed = (await env.SOURCE_CHECK_RATE_LIMIT.limit({ key: source }))?.success === true;
  } catch {
    throw new AppError("INTERNAL_ERROR", 503, { reason: "diagnostic_limiter_unavailable" });
  }
  if (!allowed) throw new AppError("RATE_LIMITED", 429, { retryAfterSeconds: 60 });

  const startedAt = Date.now();
  let result: ConnectionCheck;
  let ttlSeconds = CHECK_TTL_SECONDS;
  try {
    // Direct provider path intentionally bypasses the normal market-data cache.
    const bars = (await getProvider(source).fetch(query, {
      tushareToken: env.TUSHARE_TOKEN, tiingoKey: env.TIINGO_KEY,
      fetcher: createBudgetedFetch(env, source, symbol, options.fetcher), maxAttempts: 1,
    })).filter((bar) => bar.date >= start && bar.date <= end);
    const latest = bars.at(-1);
    result = latest
      ? { ...base, status: "ok", sample: { ...base.sample, barCount: bars.length, latestBarDate: latest.date } }
      : { ...base, status: "no_data", sample: { ...base.sample, barCount: 0 }, error: { code: "NOT_FOUND" } };
  } catch (cause) {
    const mapped = failure(cause);
    // Keep dates serializable even if an upstream sends a pathological header.
    const maxRetrySeconds = Math.floor((Date.UTC(9999, 11, 31) - now.getTime()) / 1_000);
    ttlSeconds = Math.max(CHECK_TTL_SECONDS, Math.min(mapped.retrySeconds, maxRetrySeconds));
    result = { ...base, status: mapped.status, error: mapped.error, nextCheckAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString() };
  }
  result.durationMs = Math.max(0, Date.now() - startedAt);
  if (cache) {
    const write = cache.put(key, Response.json(result, { headers: { "cache-control": `public, max-age=${ttlSeconds}` } }))
      .catch(() => undefined);
    if (options.executionCtx) options.executionCtx.waitUntil(write);
    else await write;
  }
  return result;
}
