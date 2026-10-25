import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiApp } from "../worker/api";
import { ConnectionCheckSchema } from "../worker/domain/connectivity";
import { ApiErrorSchema } from "../worker/domain/types";
import { testEnv, testExecutionContext, yahooPayload } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function streamingCheckRequest(body: ReadableStream<Uint8Array>, headers?: HeadersInit): Request {
  const init = { method: "POST", body, headers, duplex: "half" };
  return new Request("https://example.test/api/v1/sources/tushare/check", init);
}

describe("Worker API contract", () => {
  it("returns health metadata without secret state", async () => {
    const response = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/healthz"), testEnv(), testExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", version: "3.1.0", deployment: { id: "test-version" } });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-api-version")).toBe("v1");
  });

  it("publishes an API discovery document", async () => {
    const response = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/api/v1?lang=zh-CN"), testEnv(), testExecutionContext);
    const body = await response.json<{ apiVersion: string; endpoints: Array<{ operationId: string }>; disclaimer: string }>();
    expect(body.apiVersion).toBe("v1");
    expect(body.endpoints.map((endpoint) => endpoint.operationId)).toContain("getMarketData");
    expect(body.endpoints).toContainEqual({ method: "POST", path: "/api/v1/sources/{source}/check", operationId: "checkSourceConnection" });
    expect(body.disclaimer).toContain("不构成投资建议");
    expect(response.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("localizes source metadata while keeping stable field names", async () => {
    const response = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/api/v1/sources?lang=zh-CN"), testEnv(), testExecutionContext);
    const body = await response.json<{ disclaimer: string; sources: unknown[] }>();
    expect(body.disclaimer).toContain("不构成投资建议");
    expect(body.sources).toHaveLength(3);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Request-Id");
  });

  it("returns a source-specific symbol error without calling upstream", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const response = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/api/v1/market-data?source=tushare&symbol=AAPL&lang=zh-CN"), testEnv(), testExecutionContext);
    const body = await response.json<{ error: { code: string; details: { source: string } } }>();
    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({ code: "INVALID_SYMBOL", details: { source: "tushare" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates actionable upstream Retry-After metadata", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("limited", { status: 429, headers: { "retry-after": "30" } })));
    const response = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/api/v1/market-data?source=yahoo&symbol=AAPL"), testEnv(), testExecutionContext);
    const body = await response.json<{ error: { code: string } }>();
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a stable bilingual validation error", async () => {
    const response = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/api/v1/market-data?source=nope&symbol=AAPL&lang=zh-CN"), testEnv(), testExecutionContext);
    const body = await response.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.message).toBe("请求参数无效。");
    expect(body.error.requestId).toBeTruthy();
  });

  it("distinguishes unknown routes from unsupported methods", async () => {
    const methodResponse = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/api/v1/sources", { method: "POST" }), testEnv(), testExecutionContext);
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, OPTIONS");
    expect(await methodResponse.json()).toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });

    const routeResponse = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/api/v1/missing"), testEnv(), testExecutionContext);
    expect(routeResponse.status).toBe(404);
    expect(await routeResponse.json()).toMatchObject({ error: { code: "ROUTE_NOT_FOUND" } });
  });

  it("serves normalized market data with CORS and cache-safe errors", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload())));
    const response = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/api/v1/market-data?source=yahoo&symbol=AAPL&start=2026-08-01&end=2026-08-10"), testEnv(), testExecutionContext);
    const body = await response.json<{ meta: { count: number; adjustment: string }; bars: unknown[] }>();
    expect(response.status).toBe(200);
    expect(body.meta).toMatchObject({ count: 2, adjustment: "raw" });
    expect(body.bars).toHaveLength(2);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("publishes an OpenAPI 3.1 machine contract", async () => {
    const response = await createApiApp().fetch(new Request("https://quantdata.mcgeelee.workers.dev/openapi.json"), testEnv(), testExecutionContext);
    const body = await response.json<{ openapi: string; paths: Record<string, { get?: { operationId?: string }; post?: { operationId?: string; requestBody?: unknown } }> }>();
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths).toHaveProperty("/api/v1/market-data");
    expect(body.paths).toHaveProperty("/api/v1/snapshot");
    expect(body.paths).toHaveProperty("/healthz");
    expect(body.paths["/api/v1/market-data"]?.get?.operationId).toBe("getMarketData");
    expect(body.paths["/api/v1/sources/{source}/check"]?.post?.operationId).toBe("checkSourceConnection");
    expect(body.paths["/api/v1/sources/{source}/check"]?.post?.requestBody).toBeUndefined();
  });

  it("keeps API discovery and OpenAPI links on the current deployment", async () => {
    const origin = "https://my-quant.example";
    const app = createApiApp();
    const discovery = await app.fetch(new Request(`${origin}/api/v1`), testEnv(), testExecutionContext);
    expect(await discovery.json()).toMatchObject({ links: { openapi: `${origin}/openapi.json`, mcp: `${origin}/mcp` } });
    const contract = await app.fetch(new Request(`${origin}/openapi.json`), testEnv(), testExecutionContext);
    expect(await contract.json()).toMatchObject({ servers: [{ url: origin }], externalDocs: { url: `${origin}/docs/en` } });
  });

  it.each(["", "%20%20", "AAPL%2Fetc"])("rejects invalid input %j before calling a provider", async (symbol) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const response = await createApiApp().fetch(new Request(`https://example.test/api/v1/market-data?source=yahoo&symbol=${symbol}`), testEnv(), testExecutionContext);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never probes a provider during health, discovery, or source listing", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const app = createApiApp();
    for (const path of ["/healthz", "/api/v1", "/api/v1/sources", "/openapi.json"]) {
      const response = await app.fetch(new Request(`https://example.test${path}`), testEnv(), testExecutionContext);
      expect(response.status).toBe(200);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a manual check result without prices or secrets", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const response = await createApiApp().fetch(new Request("https://example.test/api/v1/sources/tiingo/check?lang=en", { method: "POST" }), testEnv(), testExecutionContext);
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(ConnectionCheckSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ source: "tiingo", status: "not_configured", cached: false, sample: { symbol: "AAPL" } });
    expect(body).not.toHaveProperty("bars");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("accepts a non-null empty HTTP body stream (zero chunk: %s)", async (zeroChunk) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      if (zeroChunk) controller.enqueue(new Uint8Array(0));
      controller.close();
    } });
    const request = streamingCheckRequest(body);
    expect(request.body).not.toBeNull();
    const response = await createApiApp().fetch(request, testEnv(), testExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: "tushare", status: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([" ", "{}", "x"])("rejects actual body bytes %j even when content-length says zero", async (value) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); }, cancel });
    const response = await createApiApp().fetch(streamingCheckRequest(body, { "content-length": "0" }), testEnv(), testExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a delayed first byte before any provider call", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      setTimeout(() => controller.enqueue(new Uint8Array([1])), 100);
    } });
    const pending = createApiApp().fetch(streamingCheckRequest(body), testEnv(), testExecutionContext);
    await vi.advanceTimersByTimeAsync(101);
    expect((await pending).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds a stalled body even if stream cancellation never completes", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const pending = createApiApp().fetch(streamingCheckRequest(new ReadableStream<Uint8Array>({ cancel })), testEnv(), testExecutionContext);
    await vi.advanceTimersByTimeAsync(1_001);
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds endless zero-byte chunks without starving the timeout", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => { controller.enqueue(new Uint8Array(0)); });
    const cancel = vi.fn();
    const response = await createApiApp().fetch(streamingCheckRequest(new ReadableStream<Uint8Array>({ pull, cancel })), testEnv(), testExecutionContext);
    expect(response.status).toBe(400);
    expect(pull.mock.calls.length).toBeLessThanOrEqual(10);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sanitizes request stream failures", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private-request-content")); } });
    const response = await createApiApp().fetch(streamingCheckRequest(body), testEnv(), testExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-request-content");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("probes one fixed sample only after an explicit valid POST", async () => {
    const payload = yahooPayload();
    payload.chart.result[0].timestamp = [Math.floor(Date.now() / 1_000)];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("caches", undefined);
    const response = await createApiApp().fetch(new Request("https://example.test/api/v1/sources/yahoo/check", { method: "POST", headers: { "cf-ray": "manual-check-id" } }), testEnv(), testExecutionContext);
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(ConnectionCheckSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ source: "yahoo", status: "ok", cached: false, requestId: "manual-check-id", sample: { symbol: "AAPL", barCount: 1 } });
    expect(body).not.toHaveProperty("bars");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: "/api/v1/sources/invalid/check", body: undefined },
    { path: "/api/v1/sources/yahoo/check?lang=invalid", body: undefined },
    { path: "/api/v1/sources/yahoo/check?symbol=MSFT", body: undefined },
    { path: "/api/v1/sources/yahoo/check", body: JSON.stringify({ source: "tiingo" }) },
  ])("rejects invalid manual check input before an upstream call: %j", async ({ path, body }) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const response = await createApiApp().fetch(new Request(`https://example.test${path}`, { method: "POST", body }), testEnv(), testExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves GET-only APIs and allows POST CORS only on the check route", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const app = createApiApp();
    const options = { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "POST" } };
    const checkOptions = await app.fetch(new Request("https://example.test/api/v1/sources/yahoo/check", options), testEnv(), testExecutionContext);
    expect(checkOptions.status).toBe(204);
    expect(checkOptions.headers.get("access-control-allow-methods")).toBe("POST,OPTIONS");
    for (const path of ["/api/v1/sources", "/api/v1/market-data", "/api/v1/sources/yahoo/check/extra"]) {
      const response = await app.fetch(new Request(`https://example.test${path}`, options), testEnv(), testExecutionContext);
      expect(response.headers.get("access-control-allow-methods")).toBe("GET,OPTIONS");
    }
    const getCheck = await app.fetch(new Request("https://example.test/api/v1/sources/yahoo/check"), testEnv(), testExecutionContext);
    expect(getCheck.status).toBe(405);
    expect(getCheck.headers.get("allow")).toBe("POST, OPTIONS");
    const postSources = await app.fetch(new Request("https://example.test/api/v1/sources", { method: "POST" }), testEnv(), testExecutionContext);
    expect(postSources.status).toBe(405);
    expect(postSources.headers.get("allow")).toBe("GET, OPTIONS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns an actionable throttle without probing when the diagnostic limiter refuses", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const response = await createApiApp().fetch(new Request("https://example.test/api/v1/sources/yahoo/check", { method: "POST" }), testEnv({ SOURCE_CHECK_RATE_LIMIT: { limit: async () => ({ success: false }) } }), testExecutionContext);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exposes the project budget code and wait on market REST errors", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("caches", undefined);
    const env = testEnv({ PROVIDER_BUDGET: { getByName: () => ({
      reserve: async () => ({ allowed: false as const, reason: "day_requests" as const, retryAfterSeconds: 180 }),
      settle: async () => undefined,
    }) } });
    const response = await createApiApp().fetch(new Request("https://example.test/api/v1/market-data?source=yahoo&symbol=AAPL&lang=zh-CN"), env, testExecutionContext);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("180");
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("QUOTA_EXCEEDED");
    expect(body.error.message).toContain("项目免费额度保护");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
