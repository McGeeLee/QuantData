// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ConnectionChecks } from "../src/components/ConnectionChecks";
import type { ConnectionCheck } from "../worker/domain/connectivity";
import { ApiClientError, checkSourceConnection, fetchMarketData } from "../src/lib/api";
import { warningText } from "../worker/lib/i18n";
import { marketFixture, sourcesFixture } from "./fixtures";

vi.mock("../src/components/MarketCharts", () => ({ MarketCharts: () => <div data-testid="charts">charts</div> }));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

const dashboardSourcesFixture = sourcesFixture.map((source) => source.id === "tiingo" ? { ...source, configured: true } : source);
const dashboardMarketFixture = { ...marketFixture, meta: { ...marketFixture.meta, source: "tiingo" as const, volumeUnit: "shares" as const } };

function mockApi(marketResponse: Response = Response.json(dashboardMarketFixture)) {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/sources")) return Promise.resolve(Response.json({ sources: dashboardSourcesFixture }));
    return Promise.resolve(marketResponse.clone());
  }));
}

describe("bilingual dashboard", () => {
  it("retains the language chosen by a direct documentation URL when returning to the dashboard", () => {
    mockApi();
    window.history.replaceState({}, "", "/docs/zh-CN");
    const docs = render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "QuantData 文档" })).toBeTruthy();
    expect(localStorage.getItem("quant-data-locale")).toBe("zh-CN");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    docs.unmount();
    window.history.replaceState({}, "", "/");
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "行情面板" })).toBeTruthy();
  });

  it("keeps the introduction on its own route without loading provider APIs", () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/about");
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Public market data, shaped for people and models." })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open dashboard" }).getAttribute("href")).toBe("/");
    expect(screen.queryByLabelText("Data source")).toBeNull();
    expect(screen.queryByRole("button", { name: /Check connection/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByRole("heading", { level: 1, name: "为用户与大模型而设计的公开行情数据。" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开行情面板" }).getAttribute("href")).toBe("/");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("opens directly on the dashboard and persists a language switch", async () => {
    mockApi();
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
    expect(screen.queryByText("Public market data, shaped for people and models.")).toBeNull();
    expect(screen.getByLabelText("Data source")).toHaveProperty("value", "tiingo");
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByRole("heading", { level: 1, name: "行情面板" })).toBeTruthy();
    expect(localStorage.getItem("quant-data-locale")).toBe("zh-CN");
  });

  it("renders metrics and all chart states after loading", async () => {
    mockApi();
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    fireEvent.click(screen.getByRole("button", { name: /Fetch market data/ }));
    await waitFor(() => expect(screen.getByText("104")).toBeTruthy());
    expect(screen.getByTestId("charts")).toBeTruthy();
    expect(screen.getAllByText("Secret not configured")).toHaveLength(1);
    const marketCall = vi.mocked(fetch).mock.calls.find(([url]) => requestUrl(url).includes("/market-data"));
    expect(marketCall && new URL(requestUrl(marketCall[0]), window.location.origin).searchParams.get("source")).toBe("tiingo");
  });

  it("announces a stable API error", async () => {
    mockApi(Response.json({ error: { code: "NOT_FOUND", message: "No market data was found.", requestId: "test-ray" } }, { status: 404 }));
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    fireEvent.click(screen.getByRole("button", { name: /Fetch market data/ }));
    await screen.findByRole("alert");
    expect(screen.getByText(/No market data was found/)).toBeTruthy();
  });
  it("validates blank and malformed symbols without calling the provider", async () => {
    mockApi();
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    const input = screen.getByLabelText(/Symbol/);
    const form = input.closest("form")!;
    for (const value of ["   ", "bad/symbol"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(form);
      expect(screen.getByRole("alert").textContent).toContain("symbol format is invalid");
    }
    expect(vi.mocked(fetch).mock.calls.every(([url]) => requestUrl(url).includes("/sources"))).toBe(true);
  });

  it("rejects reversed dates and unconfigured sources locally", async () => {
    mockApi();
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-01-01" } });
    fireEvent.submit(screen.getByRole("button", { name: /Fetch market data/ }).closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain("date range is invalid");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("Data source"), { target: { value: "tushare" } });
    fireEvent.submit(screen.getByRole("button", { name: /Fetch market data/ }).closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain("not configured on the server");
    expect(vi.mocked(fetch).mock.calls.every(([url]) => requestUrl(url).includes("/sources"))).toBe(true);
  });

  it("keeps source discovery errors separate from a successful market result", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => Promise.resolve(requestUrl(input).includes("/sources")
      ? new Response("gateway unavailable", { status: 502 }) : Response.json(dashboardMarketFixture))));
    render(<App />);
    await screen.findByText(/Could not load source configuration/);
    fireEvent.click(screen.getByRole("button", { name: /Fetch market data/ }));
    await screen.findByText("104");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Daily historical data · not a live quote", { selector: ".data-freshness strong" })).toBeTruthy();
    expect(screen.getByText("2026-08-10 00:00:00 UTC")).toBeTruthy();
  });

  it("handles an empty success and an HTML response without a blank result", async () => {
    mockApi(Response.json({ ...dashboardMarketFixture, meta: { ...dashboardMarketFixture.meta, count: 0 }, bars: [] }));
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    fireEvent.click(screen.getByRole("button", { name: /Fetch market data/ }));
    await screen.findByText("No bars were returned for this request.");
    expect(screen.queryByTestId("charts")).toBeNull();
    mockApi(new Response("<html>proxy error</html>", { status: 502 }));
    fireEvent.click(screen.getByRole("button", { name: /Fetch market data/ }));
    await screen.findByText(/service returned an unexpected response/);
  });

  it("deduplicates pending submits and uses the current language when the response arrives", async () => {
    let resolveMarket: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => { resolveMarket = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => requestUrl(input).includes("/sources")
      ? Promise.resolve(Response.json({ sources: dashboardSourcesFixture })) : pending));
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    const form = screen.getByRole("button", { name: /Fetch market data/ }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(screen.getByLabelText(/Symbol/).closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    resolveMarket(Response.json({ ...dashboardMarketFixture, meta: { ...dashboardMarketFixture.meta, warnings: [warningText("en", "raw")] } }));
    await screen.findByText("104");
    expect(screen.getByText(`• ${warningText("zh-CN", "raw")}`)).toBeTruthy();
    expect(screen.getByText("历史日线数据 · 非实时行情", { selector: ".data-freshness strong" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => requestUrl(url).includes("/market-data"))).toHaveLength(1);
  });

  it("translates a stored provider error when switching languages", async () => {
    mockApi(Response.json({ error: { code: "UPSTREAM_ERROR", message: "Provider error", requestId: "ray-123" } }, { status: 502 }));
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    fireEvent.click(screen.getByRole("button", { name: /Fetch market data/ }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByRole("alert").textContent).toContain("上游数据提供方返回错误。 (ray-123)");
  });

  it("uses the current origin in copyable API and MCP examples", async () => {
    mockApi();
    window.history.replaceState({}, "", "/about");
    render(<App />);
    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeTruthy();
    expect(screen.getByText(/^curl/).textContent).toContain(window.location.origin);
    expect(screen.getByText(/^curl/).textContent).not.toContain("quant-data.mcgeelee.workers.dev");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("continues to render and switch language if storage is blocked", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    mockApi();
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByRole("heading", { level: 1, name: "行情面板" })).toBeTruthy();
  });

});


describe("browser API boundary", () => {
  const query = { source: "yahoo", symbol: "AAPL", start: "2026-01-01", end: "2026-08-10", lang: "en" as const };

  it("rejects malformed chart data instead of crashing the chart", async () => {
    for (const result of [
      { ...marketFixture, bars: [...marketFixture.bars].reverse() },
      { ...marketFixture, meta: { ...marketFixture.meta, count: 3 } },
      { ...marketFixture, bars: [{ ...marketFixture.bars[0], close: null }] },
    ]) {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json(result))));
      await expect(fetchMarketData(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("aborts a stalled browser request after 30 seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      signal = init?.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const result = fetchMarketData(query).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(true);
    expect(await result).toEqual(new ApiClientError("REQUEST_TIMEOUT"));
  });
});


function connectionFixture(overrides: Partial<ConnectionCheck> = {}): ConnectionCheck {
  const now = new Date();
  return {
    source: "yahoo", status: "ok", checkedAt: now.toISOString(), durationMs: 178,
    cached: false, nextCheckAt: new Date(now.getTime() + 300_000).toISOString(),
    sample: { symbol: "AAPL", start: "2026-10-01", end: "2026-10-25", barCount: 17, latestBarDate: "2026-10-23" },
    requestId: "check-fixture", ...overrides,
  };
}

function checkButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Check connection: Yahoo Finance Chart" });
}

describe("manual connection checks (mock responses only)", () => {
  it("does not probe on mount, language changes or ordinary market requests", async () => {
    mockApi();
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    const details = document.querySelector<HTMLDetailsElement>(".source-details");
    expect(details?.open).toBe(false);
    if (!details) throw new Error("Missing source details disclosure");
    details.open = true;
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Check connection: Tushare Pro" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    fireEvent.click(screen.getByRole("button", { name: /获取行情数据/ }));
    await screen.findByText("104");
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("uses a bodyless manual POST and retains the original cached check across a language switch", async () => {
    const result = connectionFixture({ cached: true, checkedAt: new Date(Date.now() - 120_000).toISOString() });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json(result))));
    const { rerender, container } = render(<ConnectionChecks sources={sourcesFixture} locale="en" />);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(container.querySelector('.connection-card[data-source="yahoo"] .status-dot.ready')).toBeNull();
    fireEvent.click(checkButton());
    await screen.findByText("Sample check succeeded");
    expect(container.querySelector('.connection-card[data-source="yahoo"] .status-dot.ready')).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/sources/yahoo/check?lang=en", expect.objectContaining({ method: "POST" }));
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined();
    expect(screen.getByText("Reused result · original check time shown")).toBeTruthy();
    expect(container.querySelector(`time[datetime="${result.checkedAt}"]`)).toBeTruthy();
    expect(screen.getByText("178 ms")).toBeTruthy();
    expect(screen.getByText("17")).toBeTruthy();
    expect(checkButton().disabled).toBe(true);
    rerender(<ConnectionChecks sources={sourcesFixture} locale="zh-CN" />);
    expect(screen.getByText("样本检查成功")).toBeTruthy();
    expect(screen.getByText("复用已有结果 · 显示原始检查时间")).toBeTruthy();
    expect(container.querySelector(`time[datetime="${result.checkedAt}"]`)).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("prevents same-tick duplicate checks and aborts the pending request on unmount", () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      signal = init?.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const { unmount } = render(<ConnectionChecks sources={sourcesFixture} locale="en" />);
    fireEvent.click(checkButton());
    fireEvent.click(checkButton());
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(checkButton().disabled).toBe(true);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("reenables a cooled-down result without issuing an automatic request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json(connectionFixture()))));
    render(<ConnectionChecks sources={sourcesFixture} locale="en" />);
    await act(async () => { fireEvent.click(checkButton()); });
    expect(checkButton().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_100); });
    expect(checkButton().disabled).toBe(false);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("respects the site's Retry-After and does not report a provider failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ error: { code: "RATE_LIMITED", message: "Limit", requestId: "site-ray" } }, { status: 429, headers: { "retry-after": "120" } }))));
    const { container } = render(<ConnectionChecks sources={sourcesFixture} locale="en" />);
    await act(async () => { fireEvent.click(checkButton()); });
    expect(screen.getByText(/public rate limit has been exceeded/)).toBeTruthy();
    expect(checkButton().disabled).toBe(true);
    expect(container.querySelector(".connection-result")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_100); });
    expect(checkButton().disabled).toBe(false);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("identifies an HTML 403 as a blocked site request, without claiming Yahoo denied access", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response("<h1>Blocked</h1>", { status: 403, headers: { "content-type": "text/html" } }))));
    const { container } = render(<ConnectionChecks sources={sourcesFixture} locale="en" />);
    fireEvent.click(checkButton());
    await screen.findByText("The site request was blocked or intercepted. No provider check result was returned.");
    expect(container.querySelector(".connection-result")).toBeNull();
    expect(screen.queryByText(/Provider access denied/)).toBeNull();
  });

  it.each([
    ["not_configured", "Provider is not configured on the server."],
    ["access_denied", "Provider access denied. Access rules, credentials or plan permissions may prevent this sample request."],
    ["rate_limited", "The provider rate limited this sample request."],
    ["timeout", "The provider did not respond in time."],
    ["network_error", "The Cloudflare server could not connect to the provider."],
    ["no_data", "The provider responded but returned no usable bars for this sample."],
    ["upstream_error", "The provider returned an unexpected or unusable response."],
  ] as const)("distinguishes a completed %s check", async (status, message) => {
    const result = connectionFixture({ status, sample: { symbol: "AAPL", start: "2026-10-01", end: "2026-10-25" }, error: { code: "TEST_ERROR", ...(status === "access_denied" ? { upstreamStatus: 403 } : {}) } });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json(result))));
    const { container } = render(<ConnectionChecks sources={sourcesFixture} locale="en" />);
    fireEvent.click(checkButton());
    await screen.findByText(message);
    expect(container.querySelector(".connection-result")?.getAttribute("data-status")).toBe(status);
    if (status === "access_denied") {
      expect(screen.getByText("403")).toBeTruthy();
      expect(container.querySelector('.connection-card[data-source="yahoo"] .status-dot.failed')).toBeTruthy();
    }
  });

  it("rejects results for another source and parses an HTTP-date Retry-After", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json(connectionFixture({ source: "tiingo" })))));
    await expect(checkSourceConnection("yahoo", "en")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ error: { code: "RATE_LIMITED", message: "Limit" } }, { status: 429, headers: { "retry-after": "Sun, 25 Oct 2026 00:02:00 GMT" } }))));
    await expect(checkSourceConnection("yahoo", "en")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 120 });
  });

  it("keeps HTML gateway errors distinct from a site access block", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response("<h1>Bad gateway</h1>", { status: 502, headers: { "content-type": "text/html" } }))));
    await expect(checkSourceConnection("yahoo", "en")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("ignores Retry-After values that cannot produce a valid date", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ error: { code: "RATE_LIMITED", message: "Limit" } }, { status: 429, headers: { "retry-after": "9".repeat(300) } }))));
    await expect(checkSourceConnection("yahoo", "en")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: undefined });
  });


  it.each([
    ["quota_exceeded", "QUOTA_EXCEEDED", "This project's free-tier protection has paused requests. Please try again later.", "项目免费额度保护已暂停请求，请稍后重试。"],
    ["quota_unavailable", "QUOTA_UNAVAILABLE", "This project's free-tier protection is temporarily unavailable. Requests are paused; please try again later.", "项目免费额度保护暂不可用，已暂停请求，请稍后重试。"],
  ] as const)("distinguishes %s from a provider failure and translates the stored result", async (status, code, english, chinese) => {
    const result = connectionFixture({ status, sample: { symbol: "AAPL", start: "2026-10-01", end: "2026-10-25" }, error: { code } });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json(result))));
    const { container, rerender } = render(<ConnectionChecks sources={sourcesFixture} locale="en" />);
    fireEvent.click(checkButton());
    await screen.findByText(english);
    expect(screen.getByText("This check did not send a request to the provider.")).toBeTruthy();
    expect(container.querySelector('.connection-card[data-source="yahoo"] .status-dot.ready')).toBeNull();
    expect(container.querySelector('.connection-card[data-source="yahoo"] .status-dot.failed')).toBeNull();
    expect(screen.queryByText("The provider rate limited this sample request.")).toBeNull();
    expect(checkButton().disabled).toBe(true);
    rerender(<ConnectionChecks sources={sourcesFixture} locale="zh-CN" />);
    expect(screen.getByText(chinese)).toBeTruthy();
    expect(screen.getByText("本次检查未向供应商发送请求。")).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["QUOTA_EXCEEDED", 429, "This project's free-tier protection has paused requests. Please try again later.", "项目免费额度保护已暂停请求，请稍后重试。"],
    ["QUOTA_UNAVAILABLE", 503, "This project's free-tier protection is temporarily unavailable. Requests are paused; please try again later.", "项目免费额度保护暂不可用，已暂停请求，请稍后重试。"],
  ] as const)("uses project protection wording for the market API's %s error", async (code, status, english, chinese) => {
    mockApi(Response.json({ error: { code, message: "Server fallback text", requestId: "quota-ray" } }, { status }));
    render(<App />);
    await screen.findByText("Yahoo Finance Chart");
    fireEvent.click(screen.getByRole("button", { name: /Fetch market data/ }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain(english);
    expect(screen.getByRole("alert").textContent).not.toContain("provider");
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByRole("alert").textContent).toContain(chinese);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => requestUrl(url).includes("/market-data"))).toHaveLength(1);
  });

  it("explains shared counting and cache cost without background probes", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    const { rerender } = render(<ConnectionChecks sources={sourcesFixture} locale="en" />);
    const note = screen.getByTestId("quota-protection-note");
    expect(note.textContent).toContain("All visitors share this project's counters.");
    expect(note.textContent).toContain("Counting starts when protection is enabled and does not include other applications.");
    expect(note.textContent).toContain("One permitted, uncached check uses 1 provider request. Cache hits do not send provider requests (0).");
    expect(note.textContent).toContain("80%");
    expect(screen.getByRole("link", { name: "View project limits" }).getAttribute("href")).toBe("/docs/en#quota-protection");
    rerender(<ConnectionChecks sources={sourcesFixture} locale="zh-CN" />);
    expect(screen.getByTestId("quota-protection-note").textContent).toContain("本项目所有访客共享计数；从保护启用时开始统计，不覆盖其他应用。");
    expect(screen.getByRole("link", { name: "查看项目限额" }).getAttribute("href")).toBe("/docs/zh-CN#quota-protection");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

});
