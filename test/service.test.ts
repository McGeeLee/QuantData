import { describe, expect, it, vi } from "vitest";
import { buildCacheKey, enforceRateLimit, getMarketData, getMarketSnapshot, listSources } from "../worker/services/market-service";
import { marketFixture, yahooPayload, testEnv } from "./fixtures";

const query = { source: "yahoo" as const, symbol: "aapl", start: "2026-08-01", end: "2026-08-10" };

function memoryCache() {
  const entries = new Map<string, Response>();
  return {
    add: vi.fn(async () => undefined),
    addAll: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
    matchAll: vi.fn(async () => []),
    match: vi.fn(async (key: RequestInfo | URL) => entries.get(String(key instanceof Request ? key.url : key))?.clone()),
    put: vi.fn(async (key: RequestInfo | URL, value: Response) => { entries.set(String(key instanceof Request ? key.url : key), value.clone()); }),
    delete: vi.fn(async (key: RequestInfo | URL) => entries.delete(String(key instanceof Request ? key.url : key))),
  } satisfies Cache;
}

describe("market service", () => {
  it("stops market and snapshot calls when the shared budget refuses", async () => {
    const reserve = vi.fn(async () => ({ allowed: false as const, retryAfterSeconds: 180, reason: "day_requests" as const }));
    const env = testEnv({ PROVIDER_BUDGET: { getByName: () => ({ reserve, settle: async () => undefined }) } });
    const fetcher = vi.fn<typeof fetch>();
    for (const operation of [getMarketData, getMarketSnapshot]) {
      await expect(operation(env, query, "en", { cache: null, fetcher })).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED", status: 429, details: { retryAfterSeconds: 180 },
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it("still serves cached data when budget protection is unavailable", async () => {
    const cache = memoryCache();
    await cache.put(buildCacheKey(query), Response.json({ bars: marketFixture.bars, fetchedAt: new Date().toISOString() }));
    const fetcher = vi.fn<typeof fetch>();
    const env = testEnv({ PROVIDER_BUDGET: undefined });
    expect((await getMarketData(env, query, "en", { cache, fetcher })).meta.cache.status).toBe("hit");
    await expect(getMarketData(env, query, "en", { cache: null, fetcher })).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reserves again before a retry and never sends the refused second attempt", async () => {
    const reserve = vi.fn()
      .mockResolvedValueOnce({ allowed: true, reservationId: "first-attempt" })
      .mockResolvedValue({ allowed: false, retryAfterSeconds: 60, reason: "minute_requests" });
    const env = testEnv({ PROVIDER_BUDGET: { getByName: () => ({ reserve, settle: async () => undefined }) } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad gateway", { status: 502 }));
    await expect(getMarketData(env, query, "en", { cache: null, fetcher })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it("versions normalized cache keys separately from the public v1 API", () => {
    expect(buildCacheKey(query).url).toBe("https://quant-data-cache.internal/v2/market-data?source=yahoo&symbol=AAPL&start=2026-08-01&end=2026-08-10&interval=1d");
  });

  it("reports optional source secrets without revealing them", () => {
    const output = listSources(testEnv({ TUSHARE_TOKEN: "super-secret", TIINGO_KEY: "" }), "zh-CN");
    expect(output.sources.find((source) => source.id === "tushare")?.configured).toBe(true);
    expect(JSON.stringify(output)).not.toContain("super-secret");
    expect(output.disclaimer).toContain("不构成投资建议");
  });

  it("enforces the source-partitioned anonymous rate limit", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const request = new Request("https://example.test", { headers: { "cf-connecting-ip": "203.0.113.2" } });
    await expect(enforceRateLimit(testEnv({ MARKET_RATE_LIMIT: { limit } }), request, "yahoo")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.2:yahoo" });
  });

  it("returns localized metadata and supports truncation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload()));
    const output = await getMarketData(testEnv(), query, "zh-CN", { fetcher, cache: null, maxBars: 1 });
    expect(output.meta).toMatchObject({ count: 1, truncated: true, adjustment: "raw" });
    expect(output.meta.warnings.join(" ")).toContain("非官方接口");
    expect(output.bars[0]?.close).toBe(104);
  });

  it("calculates the latest snapshot", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload()));
    const output = await getMarketSnapshot(testEnv(), query, "en", { fetcher, cache: null });
    expect(output.snapshot).toMatchObject({ close: 104, previousClose: 100, change: 4, changePercent: 4 });
  });

  it("reports cache hits without changing provider fetchedAt", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(yahooPayload()));
    const first = await getMarketData(testEnv(), query, "en", { fetcher, cache });
    const second = await getMarketData(testEnv(), query, "zh-CN", { fetcher, cache });
    expect(first.meta.cache).toMatchObject({ status: "miss", ttlSeconds: 3600 });
    expect(second.meta.cache).toMatchObject({ status: "hit", ttlSeconds: 3600 });
    expect(second.meta.fetchedAt).toBe(first.meta.fetchedAt);
    expect(second.meta.latestBarDate).toBe("2026-08-10");
    expect(second.meta.warnings.join(" ")).toContain("非官方接口");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back to the provider when a cache read fails", async () => {
    const cache = memoryCache();
    cache.match = vi.fn().mockRejectedValue(new Error("cache unavailable"));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload()));
    const output = await getMarketData(testEnv(), query, "en", { fetcher, cache });
    expect(output.meta.cache.status).toBe("unavailable");
    expect(output.bars).toHaveLength(2);
  });

  it("does not fail successful reads when a cache write fails", async () => {
    const cache = memoryCache();
    cache.put = vi.fn().mockRejectedValue(new Error("cache unavailable"));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload()));
    const output = await getMarketData(testEnv(), query, "en", { fetcher, cache });
    expect(output.bars).toHaveLength(2);
  });

  it.each(["expired", "future", "invalid", "empty"])("ignores %s cached payloads", async (kind) => {
    const cache = memoryCache();
    const fetchedAt = new Date(Date.now() + (kind === "future" ? 60_000 : kind === "expired" ? -3_601_000 : 0)).toISOString();
    await cache.put(buildCacheKey(query), Response.json({
      bars: kind === "empty" ? [] : kind === "invalid" ? [{ ...marketFixture.bars[0], date: "2026-02-31" }] : marketFixture.bars,
      fetchedAt,
    }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload()));
    const output = await getMarketData(testEnv(), query, "en", { fetcher, cache });
    expect(output.meta.cache.status).toBe("miss");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors missing credentials even when a provider response is cached", async () => {
    const cache = memoryCache();
    const tiingoQuery = { ...query, source: "tiingo" as const };
    await cache.put(buildCacheKey(tiingoQuery), Response.json({ bars: marketFixture.bars, fetchedAt: new Date().toISOString() }));
    await expect(getMarketData(testEnv(), tiingoQuery, "en", { cache })).rejects.toMatchObject({ code: "SOURCE_NOT_CONFIGURED" });
    expect(cache.match).not.toHaveBeenCalled();
  });

  it("never includes provider bars outside the inclusive requested range", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload()));
    const output = await getMarketData(testEnv(), { ...query, start: "2026-08-10" }, "en", { fetcher, cache: null });
    expect(output.bars.map((bar) => bar.date)).toEqual(["2026-08-10"]);
  });

  it("keeps exchange-local boundary bars while excluding padded UTC days", async () => {
    const result = {
      meta: { exchangeTimezoneName: "Australia/Sydney" },
      timestamp: [1767567600, 1767654000, 1767740400],
      indicators: { quote: [{ open: [100, 100, 100], high: [110, 110, 110], low: [90, 90, 90], close: [105, 105, 105], volume: [null, null, null] }] },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ chart: { result: [result], error: null } }));
    const output = await getMarketData(testEnv(), { ...query, symbol: "BHP.AX", start: "2026-01-06", end: "2026-01-06" }, "en", { fetcher, cache: null });
    expect(output.bars.map((bar) => bar.date)).toEqual(["2026-01-06"]);
    expect(output.meta.latestBarDate).toBe("2026-01-06");
  });
});
