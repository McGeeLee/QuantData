import type { MarketDataResponse, SourceStatus } from "../worker/domain/types";
import type { RuntimeEnv } from "../worker/env";

export const sourcesFixture: SourceStatus[] = [
  { id: "yahoo", name: "Yahoo Finance Chart", configured: true, official: false, markets: ["US equities"], symbolExamples: ["AAPL"], warnings: [] },
  { id: "tushare", name: "Tushare Pro", configured: false, official: true, markets: ["China A-shares"], symbolExamples: ["600519.SH"], warnings: [] },
  { id: "tiingo", name: "Tiingo", configured: false, official: true, markets: ["US equities"], symbolExamples: ["AAPL"], warnings: [] },
];

export const marketFixture: MarketDataResponse = {
  meta: { source: "yahoo", symbol: "AAPL", interval: "1d", adjustment: "raw", volumeUnit: "provider-native units", count: 2, fetchedAt: "2026-08-10T00:00:00.000Z", latestBarDate: "2026-08-10", cache: { status: "miss", ttlSeconds: 3600, ageSeconds: 0 }, truncated: false, warnings: [] },
  bars: [
    { date: "2026-08-07", open: 99, high: 102, low: 98, close: 100, volume: 1_000 },
    { date: "2026-08-10", open: 101, high: 105, low: 100, close: 104, volume: 1_200 },
  ],
};

export function yahooPayload(): {
  chart: { result: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: Array<number | null>; high: Array<number | null>; low: Array<number | null>; close: Array<number | null>; volume: Array<number | null> }> } }>; error: null };
} {
  return {
    chart: {
      result: [{
        timestamp: [1_786_320_000, 1_786_060_800],
        indicators: { quote: [{ open: [101, 99], high: [105, 102], low: [100, 98], close: [104, 100], volume: [1_200, 1_000] }] },
      }],
      error: null,
    },
  };
}

const testFetcher: Fetcher = {
  fetch: () => Promise.resolve(new Response("asset")),
  connect: () => { throw new Error("connect is not implemented in tests"); },
};

const testLoopback = Object.assign((options: { props?: unknown }) => {
  void options;
  return testFetcher;
}, testFetcher);

export function testEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  const env: RuntimeEnv = {
    APP_VERSION: "3.1.0",
    PUBLIC_ORIGIN: "https://quantdata.mcgeelee.workers.dev",
    TUSHARE_TOKEN: "",
    TIINGO_KEY: "",
    MARKET_RATE_LIMIT: { limit: () => Promise.resolve({ success: true }) },
    SOURCE_CHECK_RATE_LIMIT: { limit: () => Promise.resolve({ success: true }) },
    // Explicit test double; production never bypasses persistent budget checks.
    PROVIDER_BUDGET: { getByName: () => ({
      reserve: async () => ({ allowed: true as const, reservationId: crypto.randomUUID() }),
      settle: async () => undefined,
    }) },
    VERSION_METADATA: { id: "test-version", tag: "test", timestamp: "2026-08-10T00:00:00.000Z" },
    ASSETS: testFetcher,
  };
  return { ...env, ...overrides };
}

class TestSpan {
  get isTraced() { return false; }
  setAttribute() { /* no-op */ }
  end() { /* no-op */ }
}

export const testExecutionContext: ExecutionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  exports: {
    default: testLoopback,
    get ProviderBudget(): ExecutionContext["exports"]["ProviderBudget"] {
      throw new Error("DO loopback is tested only in local workerd");
    },
  },
  props: {},
  tracing: {
    enterSpan: (_name, callback, ...args) => callback(new TestSpan(), ...args),
    startActiveSpan: (_name, callback, ...args) => callback(new TestSpan(), ...args),
    Span: TestSpan,
  },
};
