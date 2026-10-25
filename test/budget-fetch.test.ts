import { afterEach, describe, expect, it, vi } from "vitest";
import { createBudgetedFetch } from "../worker/lib/budgeted-fetch";
import { fetchUpstream } from "../worker/lib/upstream-fetch";
import { MAX_PROVIDER_BODY_BYTES, type ProviderBudgetNamespace, type ReservationResult } from "../worker/services/provider-budget";

function binding() {
  const reserve = vi.fn<() => Promise<ReservationResult>>().mockResolvedValue({ allowed: true, reservationId: "reservation" });
  const settle = vi.fn<(input: { reservationId: string; bytes: number }) => Promise<void>>().mockResolvedValue(undefined);
  const getByName = vi.fn(() => ({ reserve, settle }));
  return { env: { PROVIDER_BUDGET: { getByName } satisfies ProviderBudgetNamespace }, reserve, settle, getByName };
}

afterEach(() => vi.useRealTimers());

describe("budgeted provider transport", () => {
  it("reserves before network, uses the stable source and preserves signal while blocking redirects", async () => {
    const budget = binding();
    const signal = new AbortController().signal;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      expect(budget.reserve).toHaveBeenCalledExactlyOnceWith({ source: "tiingo", symbol: "AAPL" });
      return new Response("café", { headers: { "content-type": "text/plain", "content-encoding": "gzip", "content-length": "100" } });
    });
    const response = await createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid", { signal, redirect: "follow" });
    expect(budget.getByName).toHaveBeenCalledWith("tiingo");
    expect(fetcher).toHaveBeenCalledWith("https://provider.invalid", { signal, redirect: "manual" });
    expect(budget.settle).toHaveBeenCalledExactlyOnceWith({ reservationId: "reservation", bytes: 5 });
    expect(await response.text()).toBe("café");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  it("fails closed for missing, broken or malformed budget infrastructure without leaking errors", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createBudgetedFetch({}, "yahoo", "AAPL", fetcher)("https://provider.invalid")).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE", status: 503 });
    const budget = binding();
    budget.reserve.mockRejectedValue(new Error("token=secret"));
    await expect(createBudgetedFetch(budget.env, "yahoo", "AAPL", fetcher)("https://provider.invalid")).rejects.toMatchObject({ message: "QUOTA_UNAVAILABLE", details: undefined });
    budget.reserve.mockResolvedValue({ allowed: true } as ReservationResult);
    await expect(createBudgetedFetch(budget.env, "yahoo", "AAPL", fetcher)("https://provider.invalid")).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns only allowlisted local denial metadata and never attempts network", async () => {
    const budget = binding();
    budget.reserve.mockResolvedValue({ allowed: false, reason: "monthly_bytes", retryAfterSeconds: 123 });
    const fetcher = vi.fn<typeof fetch>();
    await expect(createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid")).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED", status: 429, details: { reason: "monthly_bytes", retryAfterSeconds: 123 },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("counts every automatic network retry and sanitizes the transport failure", async () => {
    const budget = binding();
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("token=secret"))
      .mockResolvedValueOnce(new Response("{}"));
    const response = await fetchUpstream("https://provider.invalid", {}, createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher));
    expect(await response.text()).toBe("{}");
    expect(budget.reserve).toHaveBeenCalledTimes(2);
    expect(budget.settle).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValue(new Error("token=secret"));
    await expect(createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid")).rejects.toThrow("Provider network request failed");
  });

  it("blocks a retry whose next reservation is refused", async () => {
    const budget = binding();
    budget.reserve.mockResolvedValueOnce({ allowed: true, reservationId: "first" })
      .mockResolvedValue({ allowed: false, reason: "hour_requests", retryAfterSeconds: 90 });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await expect(fetchUpstream("https://provider.invalid", {}, createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher))).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(budget.reserve).toHaveBeenCalledTimes(2);
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it("keeps the full reservation for non-2xx without reading the body", async () => {
    const budget = binding();
    const response = new Response("provider error: secret", { status: 403 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid")).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it.each([301, 302, 303, 307, 308])("rejects HTTP %i without following or retrying the redirect", async (status) => {
    const budget = binding();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("redirect", {
      status, headers: { location: "https://unreserved.invalid" },
    }));
    await expect(fetchUpstream("https://provider.invalid", {}, createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR", status: 502, details: { upstreamStatus: status },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(budget.reserve).toHaveBeenCalledTimes(1);
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it("keeps reservations on declared or streamed oversized bodies", async () => {
    const budget = binding();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("small", { headers: { "content-length": String(MAX_PROVIDER_BODY_BYTES + 1) } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(MAX_PROVIDER_BODY_BYTES + 1)));
    const wrapped = createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher);
    for (let n = 0; n < 2; n++) await expect(wrapped("https://provider.invalid")).rejects.toMatchObject({ code: "UPSTREAM_ERROR", details: { reason: "payload_too_large" } });
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it("buffers the exact size limit and charges measured bytes", async () => {
    const budget = binding();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(MAX_PROVIDER_BODY_BYTES)));
    const response = await createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid");
    expect((await response.arrayBuffer()).byteLength).toBe(MAX_PROVIDER_BODY_BYTES);
    expect(budget.settle).toHaveBeenCalledWith({ reservationId: "reservation", bytes: MAX_PROVIDER_BODY_BYTES });
  });

  it("sanitizes mid-body network errors and never refunds incomplete responses", async () => {
    const budget = binding();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("key=secret")); },
    })));
    const error: unknown = await createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid").catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", details: { reason: "network_error" } });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("secret");
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it("bounds stalled body reads even if cancellation never finishes", async () => {
    vi.useFakeTimers();
    const budget = binding();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel: () => new Promise(() => undefined) })));
    const result = createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid");
    const assertion = expect(result).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it("cancels a pending response through the caller signal and preserves its reservation", async () => {
    const budget = binding();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      queueMicrotask(() => controller.abort());
      return new Response(new ReadableStream());
    });
    await expect(createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it("bounds empty-chunk streams and accepts responses with no body", async () => {
    const budget = binding();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); } })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const wrapped = createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher);
    await expect(wrapped("https://provider.invalid")).rejects.toMatchObject({ code: "UPSTREAM_ERROR", details: { reason: "invalid_body" } });
    expect((await wrapped("https://provider.invalid")).status).toBe(204);
    expect(budget.settle).toHaveBeenCalledExactlyOnceWith({ reservationId: "reservation", bytes: 0 });
  });

  it("returns already received data if settlement fails, keeping the durable reservation charged", async () => {
    const budget = binding();
    budget.settle.mockRejectedValue(new Error("storage offline"));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const response = await createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid");
    expect(await response.text()).toBe("{}");
    expect(budget.reserve).toHaveBeenCalledTimes(1);
  });

  it("times out unavailable reservations and never starts an unbudgeted fetch", async () => {
    vi.useFakeTimers();
    const budget = binding();
    budget.reserve.mockReturnValue(new Promise(() => undefined));
    const fetcher = vi.fn<typeof fetch>();
    const assertion = expect(createBudgetedFetch(budget.env, "tiingo", "AAPL", fetcher)("https://provider.invalid")).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
    expect(fetcher).not.toHaveBeenCalled();
  });
});
