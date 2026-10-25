import type { DataSource } from "../domain/types";
import {
  MAX_PROVIDER_BODY_BYTES, PROVIDER_BODY_TIMEOUT_MS,
  type BudgetEnv, type BudgetReason, type ProviderBudgetStub, type ReservationResult,
} from "../services/provider-budget";
import { AppError } from "./app-error";

const REASONS: readonly BudgetReason[] = ["minute_requests", "hour_requests", "day_requests", "monthly_symbols", "monthly_bytes"];

async function boundedRpc<T>(operation: () => Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Budget RPC deadline")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function validReservation(value: ReservationResult): boolean {
  if (!value || typeof value !== "object") return false;
  if (value.allowed === true) return typeof value.reservationId === "string" && value.reservationId.length > 0;
  return value.allowed === false && REASONS.includes(value.reason)
    && Number.isSafeInteger(value.retryAfterSeconds) && value.retryAfterSeconds > 0;
}

function abortError(): DOMException {
  return new DOMException("Provider request aborted", "AbortError");
}

async function bufferResponse(response: Response, signal?: AbortSignal | null): Promise<{ body: ArrayBuffer | null; bytes: number }> {
  const tooLarge = () => new AppError("UPSTREAM_ERROR", 502, { reason: "payload_too_large" });
  if (Number(response.headers.get("content-length")) > MAX_PROVIDER_BODY_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw abortError();
  }
  if (!response.body) return { body: null, bytes: 0 };

  const reader = response.body.getReader();
  // Geometric growth bounds tiny-chunk overhead without preallocating 5 MiB per small response.
  let buffer = new Uint8Array(16 * 1024);
  let bytes = 0;
  let emptyChunks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AppError("UPSTREAM_TIMEOUT", 504)), PROVIDER_BODY_TIMEOUT_MS);
    onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) {
        // A pathological synchronous stream must not starve the deadline timer forever.
        if (++emptyChunks > 32) throw new AppError("UPSTREAM_ERROR", 502, { reason: "invalid_body" });
        continue;
      }
      emptyChunks = 0;
      if (bytes + chunk.value.byteLength > MAX_PROVIDER_BODY_BYTES) throw tooLarge();
      if (bytes + chunk.value.byteLength > buffer.byteLength) {
        let capacity = buffer.byteLength;
        while (capacity < bytes + chunk.value.byteLength) capacity = Math.min(capacity * 2, MAX_PROVIDER_BODY_BYTES);
        const grown = new Uint8Array(capacity);
        grown.set(buffer.subarray(0, bytes));
        buffer = grown;
      }
      buffer.set(chunk.value, bytes);
      bytes += chunk.value.byteLength;
    }
    return { body: buffer.slice(0, bytes).buffer, bytes };
  } catch (error) {
    // Never await cancellation: a broken upstream can leave its cancel promise pending.
    void reader.cancel().catch(() => undefined);
    if (error instanceof AppError) throw error;
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw abortError();
    throw new AppError("UPSTREAM_ERROR", 502, { reason: "network_error" });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Wrap every actual fetch attempt, including retries and manual connectivity probes. */
export function createBudgetedFetch(env: BudgetEnv, source: DataSource, symbol: string, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw abortError();
    let stub: ProviderBudgetStub;
    let reservation: ReservationResult;
    try {
      if (!env.PROVIDER_BUDGET) throw new Error("Missing provider budget binding");
      stub = env.PROVIDER_BUDGET.getByName(source);
      reservation = await boundedRpc(() => stub.reserve({ source, symbol }), 5_000);
      if (!validReservation(reservation)) throw new Error("Invalid budget response");
    } catch {
      throw new AppError("QUOTA_UNAVAILABLE", 503);
    }
    if (!reservation.allowed) {
      throw new AppError("QUOTA_EXCEEDED", 429, {
        reason: reservation.reason, retryAfterSeconds: reservation.retryAfterSeconds,
      });
    }
    if (signal?.aborted) throw abortError();

    let response: Response;
    try {
      // Workers supports only follow/manual; "error" throws before any network I/O.
      // Return redirects to fetchUpstream's non-2xx handler without following them,
      // spending another unreserved request, or forwarding credentials elsewhere.
      response = await fetcher(input, { ...init, redirect: "manual" });
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw abortError();
      // A plain network error remains retryable by fetchUpstream, without raw provider details.
      // eslint-disable-next-line preserve-caught-error -- Raw upstream errors may include credential URLs; exclude them from traces as well as responses.
      throw new TypeError("Provider network request failed");
    }
    // Keep the full reservation on errors; the caller handles/cancels the original body.
    if (!response.ok) return response;

    const buffered = await bufferResponse(response, signal);
    if (source === "tiingo") {
      try {
        await boundedRpc(() => stub.settle({ reservationId: reservation.reservationId, bytes: buffered.bytes }), 2_000);
      } catch {
        // The durable reservation remains charged. Returning already received data is safe.
      }
    }
    const headers = new Headers(response.headers);
    // fetch streams may be decoded; do not label the rebuilt body with the wire encoding/size.
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(buffered.body, { status: response.status, statusText: response.statusText, headers });
  };
}
