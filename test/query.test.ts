import { describe, expect, it } from "vitest";
import { normalizeMarketQuery } from "../worker/lib/query";

describe("market query normalization", () => {
  it("normalizes provider-native symbols", () => {
    expect(normalizeMarketQuery({ source: "yahoo", symbol: "btc-usd" }, new Date("2026-08-10T00:00:00Z")))
      .toEqual({ source: "yahoo", symbol: "BTC-USD", start: "2026-07-10", end: "2026-08-10" });
  });

  it("rejects impossible calendar dates", () => {
    expect(() => normalizeMarketQuery({ source: "yahoo", symbol: "AAPL", start: "2026-02-31", end: "2026-03-01" }))
      .toThrow(expect.objectContaining({ code: "INVALID_DATE_RANGE" }));
  });

  it.each([
    ["2026-03-31", "2026-02-28"],
    ["2024-03-31", "2024-02-29"],
    ["2026-01-31", "2025-12-31"],
    ["2024-02-29", "2024-01-29"],
    ["2026-05-31", "2026-04-30"],
  ])("defaults to one calendar month before %s, clamped to %s", (end, start) => {
    expect(normalizeMarketQuery({ source: "yahoo", symbol: "AAPL", end }, new Date("2026-08-10T00:00:00Z")))
      .toMatchObject({ start, end });
  });

  it.each(["", "   ", "AAPL/../../", "AAPL?token=secret"])("rejects invalid symbol %j", (symbol) => {
    expect(() => normalizeMarketQuery({ source: "yahoo", symbol })).toThrow(expect.objectContaining({ code: "INVALID_SYMBOL" }));
  });

  it.each([
    { start: "2026-08-10", end: "2026-08-01" },
    { start: "2010-01-01", end: "2026-08-01" },
    { end: "2026-02-31" },
    { end: "" },
  ])("rejects invalid range %j", (range) => {
    expect(() => normalizeMarketQuery({ source: "yahoo", symbol: "AAPL", ...range })).toThrow(expect.objectContaining({ code: "INVALID_DATE_RANGE" }));
  });

  it("enforces source-specific symbol formats", () => {
    let thrown: unknown;
    try {
      normalizeMarketQuery({ source: "tushare", symbol: "AAPL" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INVALID_SYMBOL", details: { source: "tushare" } });
    expect(normalizeMarketQuery({ source: "tushare", symbol: "600519.sh" }).symbol).toBe("600519.SH");
  });
});
