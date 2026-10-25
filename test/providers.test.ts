import { describe, expect, it, vi } from "vitest";
import { tiingoProvider } from "../worker/providers/tiingo";
import { tushareProvider } from "../worker/providers/tushare";
import { yahooProvider } from "../worker/providers/yahoo";
import { fetchUpstream, readJson } from "../worker/lib/upstream-fetch";
import type { MarketQuery } from "../worker/domain/types";
import { yahooPayload } from "./fixtures";
import { createBar } from "../worker/providers/normalize";

const query: MarketQuery = { source: "yahoo", symbol: "AAPL", start: "2026-08-01", end: "2026-08-10" };

describe("market data providers", () => {
  it("normalizes and sorts Yahoo bars", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload()));
    const bars = await yahooProvider.fetch(query, { fetcher });
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.date)).toEqual(["2026-08-07", "2026-08-10"]);
    expect(bars[1]?.close).toBe(104);
  });

  it("uses the exchange trading date and pads the UTC fetch window", async () => {
    const payload = yahooPayload();
    const result = { ...payload.chart.result[0], meta: { exchangeTimezoneName: "Australia/Sydney" }, timestamp: [1767654000] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ chart: { result: [result], error: null } }));
    const bars = await yahooProvider.fetch({ ...query, symbol: "BHP.AX", start: "2026-01-06", end: "2026-01-06" }, { fetcher });
    expect(bars[0]?.date).toBe("2026-01-06");
    const url = fetcher.mock.calls[0]?.[0];
    if (!(url instanceof URL)) throw new Error("Expected provider URL");
    expect(Number(url.searchParams.get("period1"))).toBe(Date.parse("2026-01-05T00:00:00Z") / 1_000);
    expect(Number(url.searchParams.get("period2"))).toBe(Date.parse("2026-01-08T00:00:00Z") / 1_000);
  });

  it("maps an empty Yahoo result to an empty series", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ chart: { result: null, error: null } }));
    await expect(yahooProvider.fetch(query, { fetcher })).resolves.toEqual([]);
  });

  it("handles a Yahoo no-trading-days payload without timestamps", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ chart: { result: [{ indicators: { quote: [{}] } }], error: null } }));
    await expect(yahooProvider.fetch(query, { fetcher })).resolves.toEqual([]);
  });

  it("keeps missing Yahoo volume unknown", async () => {
    const payload = yahooPayload();
    payload.chart.result[0].indicators.quote[0].volume = [null, null];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    const bars = await yahooProvider.fetch(query, { fetcher });
    expect(bars).toHaveLength(2);
    expect(bars.every((bar) => bar.volume === null)).toBe(true);
  });

  it("does not turn provider errors into an empty successful result", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ chart: { result: null, error: { code: "Unauthorized" } } }));
    await expect(yahooProvider.fetch(query, { fetcher })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("rejects invalid provider dates and contradictory prices", () => {
    const row = { date: "2026-08-10", open: 100, high: 110, low: 90, close: 105, volume: null };
    expect(createBar({ ...row, date: "2026-02-31" })).toBeNull();
    expect(createBar({ ...row, high: 95 })).toBeNull();
    expect(createBar({ ...row, volume: -1 })?.volume).toBeNull();
    expect(createBar({ ...row, close: null })).toBeNull();
  });

  it("drops Yahoo rows with missing required price fields", async () => {
    const payload = yahooPayload();
    payload.chart.result[0].indicators.quote[0].close = [null, 100];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    const bars = await yahooProvider.fetch(query, { fetcher });
    expect(bars).toHaveLength(1);
  });

  it("maps Tushare fields and sorts descending provider data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code: 0,
      data: {
        fields: ["ts_code", "trade_date", "open", "high", "low", "close", "vol"],
        items: [["600519.SH", "20260810", 1400, 1420, 1390, 1410, 200], ["600519.SH", "20260808", 1390, 1405, 1380, 1400, 180]],
      },
    }));
    const bars = await tushareProvider.fetch({ ...query, source: "tushare", symbol: "600519.SH" }, { tushareToken: "test", fetcher });
    expect(bars.map((bar) => bar.date)).toEqual(["2026-08-08", "2026-08-10"]);
    expect(bars[1]?.volume).toBe(200);
  });

  it("rejects Tushare when its secret is missing", async () => {
    await expect(tushareProvider.fetch({ ...query, source: "tushare" }, {})).rejects.toMatchObject({ code: "SOURCE_NOT_CONFIGURED", status: 503 });
  });

  it("rejects a Tushare payload missing required fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code: 0,
      data: { fields: ["trade_date", "open"], items: [["20260810", 10]] },
    }));
    await expect(tushareProvider.fetch({ ...query, source: "tushare", symbol: "600519.SH" }, { tushareToken: "test", fetcher }))
      .rejects.toMatchObject({ code: "UPSTREAM_ERROR", details: { reason: "invalid_payload" } });
  });

  it("normalizes Tiingo raw price fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      { date: "2026-08-10T00:00:00.000Z", open: 101, high: 105, low: 100, close: 104, volume: 1200 },
    ]));
    const bars = await tiingoProvider.fetch({ ...query, source: "tiingo" }, { tiingoKey: "test", fetcher });
    expect(bars[0]).toEqual({ date: "2026-08-10", open: 101, high: 105, low: 100, close: 104, volume: 1200 });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Token test" });
  });

  it("does not roll an impossible provider date into a real trading date", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      { date: "2026-02-31T00:00:00.000Z", open: 101, high: 105, low: 100, close: 104, volume: 1200 },
    ]));
    await expect(tiingoProvider.fetch({ ...query, source: "tiingo" }, { tiingoKey: "test", fetcher })).resolves.toEqual([]);
  });
});

describe("upstream fetch behavior", () => {
  it("retries one transient response", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(fetchUpstream("https://example.test", {}, fetcher, 100)).resolves.toHaveProperty("status", 200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("maps an upstream timeout after one retry", async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await expect(fetchUpstream("https://example.test", {}, fetcher, 5)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", status: 504 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns a long upstream retry delay without holding the Worker open", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("limited", { status: 429, headers: { "retry-after": "30" } }));
    await expect(fetchUpstream("https://example.test", {}, fetcher, 100)).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      details: { retryAfterSeconds: 30 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not spend a second call on an upstream throttle with no Retry-After", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("limited", { status: 429 }));
    await expect(fetchUpstream("https://example.test", {}, fetcher)).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED", details: { upstreamStatus: 429 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds upstream JSON bodies", async () => {
    await expect(readJson(Response.json({ value: "too large" }), 5)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      details: { reason: "payload_too_large" },
    });
  });

  it("maps a provider 404 to a no-data error without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("missing", { status: 404 }));
    await expect(fetchUpstream("https://example.test", {}, fetcher)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out and cancels a body that stalls after successful headers", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(readJson(new Response(stream), 100, 5)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", status: 504 });
    expect(cancel).toHaveBeenCalledWith("upstream_timeout");
  });
});
