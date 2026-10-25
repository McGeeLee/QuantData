import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionCheckSchema } from "../worker/domain/connectivity";
import { checkSourceConnection, buildConnectionCacheKey } from "../worker/services/connectivity-service";
import { testEnv, yahooPayload } from "./fixtures";

const now = new Date("2026-08-10T12:00:00Z");
const options = { requestId: "check-request", now, cache: null };

function memoryCache() {
  const entries = new Map<string, Response>();
  const keyOf = (key: RequestInfo | URL) => key instanceof Request ? key.url : String(key);
  return {
    add: vi.fn(async () => undefined), addAll: vi.fn(async () => undefined),
    keys: vi.fn(async () => []), matchAll: vi.fn(async () => []),
    match: vi.fn(async (key: RequestInfo | URL) => entries.get(keyOf(key))?.clone()),
    put: vi.fn(async (key: RequestInfo | URL, value: Response) => { entries.set(keyOf(key), value.clone()); }),
    delete: vi.fn(async (key: RequestInfo | URL) => entries.delete(keyOf(key))),
  } satisfies Cache;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("manual provider connectivity", () => {
  it("distinguishes local budget protection from provider throttling and caches its wait", async () => {
    const reserve = vi.fn(async () => ({ allowed: false as const, reason: "day_requests" as const, retryAfterSeconds: 900 }));
    const env = testEnv({ PROVIDER_BUDGET: { getByName: () => ({ reserve, settle: async () => undefined }) } });
    const cache = memoryCache();
    const fetcher = vi.fn<typeof fetch>();
    const first = await checkSourceConnection(env, "yahoo", { ...options, cache, fetcher });
    expect(first).toMatchObject({ status: "quota_exceeded", nextCheckAt: "2026-08-10T12:15:00.000Z", error: { code: "QUOTA_EXCEEDED" } });
    const second = await checkSourceConnection(env, "yahoo", { ...options, cache, fetcher });
    expect(second).toMatchObject({ status: "quota_exceeded", cached: true });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports unavailable budget protection without contacting a provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await checkSourceConnection(testEnv({ PROVIDER_BUDGET: undefined }), "yahoo", { ...options, fetcher });
    expect(result).toMatchObject({ status: "quota_unavailable", error: { code: "QUOTA_UNAVAILABLE" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("probes a fixed recent sample directly and returns metadata without prices", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload()));
    const limit = vi.fn().mockResolvedValue({ success: true });
    const result = await checkSourceConnection(testEnv({ SOURCE_CHECK_RATE_LIMIT: { limit } }), "yahoo", { ...options, fetcher });
    expect(ConnectionCheckSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: "ok", cached: false, checkedAt: now.toISOString(), nextCheckAt: "2026-08-10T12:05:00.000Z",
      sample: { symbol: "AAPL", start: "2026-07-10", end: "2026-08-10", barCount: 2, latestBarDate: "2026-08-10" },
    });
    expect(result).not.toHaveProperty("bars");
    expect(JSON.stringify(result)).not.toContain("close");
    expect(limit).toHaveBeenCalledWith({ key: "yahoo" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reuses only diagnostic cache and keeps observation provenance", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(yahooPayload()));
    const limit = vi.fn().mockResolvedValue({ success: true });
    const env = testEnv({ SOURCE_CHECK_RATE_LIMIT: { limit } });
    const first = await checkSourceConnection(env, "yahoo", { ...options, fetcher, cache });
    first.durationMs = 47;
    await cache.put(buildConnectionCacheKey("yahoo", "test-version"), Response.json(first));
    const second = await checkSourceConnection(env, "yahoo", { ...options, fetcher, cache, now: new Date(now.getTime() + 60_000), requestId: "new-request" });
    expect(second).toEqual({ ...first, cached: true, requestId: "new-request" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledTimes(1);
    expect(buildConnectionCacheKey("yahoo", "v1").url).toBe("https://quant-data-cache.internal/connectivity/v1/yahoo?version=v1");
  });

  it("invalidates checks when the Worker version changes", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(yahooPayload()));
    const env = testEnv();
    await checkSourceConnection(env, "yahoo", { ...options, fetcher, cache });
    await checkSourceConnection({ ...env, VERSION_METADATA: { ...env.VERSION_METADATA, id: "after-secret-update" } }, "yahoo", { ...options, fetcher, cache });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("checks missing credentials before a previously successful cached result", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ date: "2026-08-10", open: 100, high: 102, low: 99, close: 101, volume: null }]));
    await checkSourceConnection(testEnv({ TIINGO_KEY: "not-a-real-key" }), "tiingo", { ...options, fetcher, cache });
    const result = await checkSourceConnection(testEnv(), "tiingo", { ...options, fetcher, cache });
    expect(result).toMatchObject({ status: "not_configured", cached: false, error: { code: "SOURCE_NOT_CONFIGURED" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not probe a missing Tushare credential or use the limiter", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const limit = vi.fn();
    const result = await checkSourceConnection(testEnv({ SOURCE_CHECK_RATE_LIMIT: { limit } }), "tushare", { ...options, fetcher });
    expect(result).toMatchObject({ status: "not_configured", sample: { symbol: "600519.SH" } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 502, 503, 504, 404])("makes only one request for upstream HTTP %i", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("do not expose upstream body", { status }));
    const result = await checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher });
    const expected = status === 401 || status === 403 ? "access_denied" : status === 429 ? "rate_limited" : status === 404 ? "no_data" : "upstream_error";
    expect(result.status).toBe(expected);
    if (status !== 404) expect(result.error?.upstreamStatus).toBe(status);
    expect(JSON.stringify(result)).not.toContain("do not expose");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("respects a longer upstream Retry-After when reusing a failure", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("limited", { status: 429, headers: { "retry-after": "900" } }));
    const first = await checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher, cache });
    expect(first.nextCheckAt).toBe("2026-08-10T12:15:00.000Z");
    const second = await checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher, cache, now: new Date(now.getTime() + 600_000) });
    expect(second.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a transport failure without leaking exception details or retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-token-at-provider-host"));
    const result = await checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher });
    expect(result).toMatchObject({ status: "network_error", error: { code: "UPSTREAM_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a single-attempt timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({ status: "timeout", error: { code: "UPSTREAM_TIMEOUT" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a transport interruption after headers from malformed JSON", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"chart":')); },
      pull(controller) { controller.error(new TypeError("network reset with not-a-real-key")); },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const result = await checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher });
    expect(result).toMatchObject({ status: "network_error", error: { code: "UPSTREAM_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("not-a-real-key");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response("{invalid-json"));
    expect(await checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher: malformed })).toMatchObject({ status: "upstream_error" });
  });

  it("keeps Tushare rejection numeric without guessing permissions or exposing messages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: -1234, msg: "bad token not-a-real-key", data: null }));
    const result = await checkSourceConnection(testEnv({ TUSHARE_TOKEN: "not-a-real-key" }), "tushare", { ...options, fetcher });
    expect(result).toMatchObject({ status: "upstream_error", error: { code: "UPSTREAM_ERROR", providerCode: -1234 } });
    expect(JSON.stringify(result)).not.toContain("not-a-real-key");
    expect(JSON.stringify(result)).not.toContain("msg");
  });

  it("reports a normalized empty sample distinctly", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ chart: { result: null, error: null } }));
    const result = await checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher });
    expect(result).toMatchObject({ status: "no_data", sample: { barCount: 0 }, error: { code: "NOT_FOUND" } });
  });

  it("fails closed when the probe limiter is unavailable", async () => {
    const limit = vi.fn().mockRejectedValue(new Error("limiter offline"));
    const fetcher = vi.fn<typeof fetch>();
    await expect(checkSourceConnection(testEnv({ SOURCE_CHECK_RATE_LIMIT: { limit } }), "yahoo", { ...options, fetcher }))
      .rejects.toMatchObject({ status: 503, code: "INTERNAL_ERROR", details: { reason: "diagnostic_limiter_unavailable" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a cache read failure bounded by the diagnostic limiter", async () => {
    const cache = memoryCache();
    cache.match.mockRejectedValue(new Error("cache offline"));
    const fetcher = vi.fn<typeof fetch>();
    const limit = vi.fn().mockResolvedValue({ success: false });
    await expect(checkSourceConnection(testEnv({ SOURCE_CHECK_RATE_LIMIT: { limit } }), "yahoo", { ...options, fetcher, cache }))
      .rejects.toMatchObject({ code: "RATE_LIMITED", status: 429, details: { retryAfterSeconds: 60 } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps successful probes available on cache-write failure without bypassing the next limit", async () => {
    const cache = memoryCache();
    cache.put.mockRejectedValue(new Error("cache write offline"));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload()));
    const limit = vi.fn().mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const env = testEnv({ SOURCE_CHECK_RATE_LIMIT: { limit } });
    expect(await checkSourceConnection(env, "yahoo", { ...options, fetcher, cache })).toMatchObject({ status: "ok" });
    await expect(checkSourceConnection(env, "yahoo", { ...options, fetcher, cache })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["expired", "future", "wrong_source", "wrong_sample", "malformed"])("ignores %s diagnostic cache entries", async (kind) => {
    const cache = memoryCache();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(yahooPayload()));
    const result = await checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher, cache: null });
    const changes = kind === "expired" ? { checkedAt: "2026-08-10T11:00:00Z", nextCheckAt: "2026-08-10T11:05:00Z" }
      : kind === "future" ? { checkedAt: "2026-08-11T11:00:00Z", nextCheckAt: "2026-08-11T11:05:00Z" }
      : kind === "wrong_source" ? { source: "tiingo" }
      : kind === "wrong_sample" ? { sample: { ...result.sample, symbol: "UNTRUSTED" } }
      : { durationMs: "not a number" };
    await cache.put(buildConnectionCacheKey("yahoo", "test-version"), Response.json({ ...result, ...changes }));
    const checked = await checkSourceConnection(testEnv(), "yahoo", { ...options, fetcher, cache });
    expect(checked.cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
