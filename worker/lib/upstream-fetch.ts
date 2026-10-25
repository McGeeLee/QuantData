import { AppError } from "./app-error";

const RETRYABLE = new Set([502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;

function retryDelay(response?: Response): { milliseconds: number; seconds: number } {
  const retryAfter = response?.headers.get("retry-after");
  if (!retryAfter) return { milliseconds: 250, seconds: 1 };
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    const normalized = Math.max(seconds, 0);
    return { milliseconds: normalized * 1_000, seconds: Math.ceil(normalized) };
  }
  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) {
    const milliseconds = Math.max(date - Date.now(), 0);
    return { milliseconds, seconds: Math.ceil(milliseconds / 1_000) };
  }
  return { milliseconds: 250, seconds: 1 };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchUpstream(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts: 1 | 2 = 2,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const canRetry = attempt + 1 < maxAttempts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(input, { ...init, signal: controller.signal });
      if (response.status === 429) {
        const retry = retryDelay(response);
        void response.body?.cancel().catch(() => undefined);
        // A provider throttle must remain visible and must not spend another call.
        throw new AppError("UPSTREAM_RATE_LIMITED", 503, {
          upstreamStatus: 429,
          retryAfterSeconds: retry.seconds,
        });
      }
      if (RETRYABLE.has(response.status) && canRetry) {
        void response.body?.cancel().catch(() => undefined);
        await delay(250);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 404) throw new AppError("NOT_FOUND", 404);
        throw new AppError("UPSTREAM_ERROR", 502, { upstreamStatus: response.status });
      }
      return response;
    } catch (error) {
      if (error instanceof AppError) throw error;
      lastError = error;
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      if (aborted) {
        if (canRetry) continue;
        throw new AppError("UPSTREAM_TIMEOUT", 504, undefined, { cause: error });
      }
      if (canRetry) continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AppError("UPSTREAM_ERROR", 502, { reason: "network_error" }, { cause: lastError });
}

export async function readJson(response: Response, maxBytes = MAX_JSON_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new AppError("UPSTREAM_ERROR", 502, { reason: "payload_too_large" });
  }
  if (!response.body) throw new AppError("UPSTREAM_ERROR", 502, { reason: "empty_body" });
  const reader = response.body.getReader();
  // A server can send headers promptly then stall forever while streaming JSON.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AppError("UPSTREAM_TIMEOUT", 504));
      void reader.cancel("upstream_timeout").catch(() => undefined);
    }, timeoutMs);
  });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel("payload_too_large").catch(() => undefined);
        throw new AppError("UPSTREAM_ERROR", 502, { reason: "payload_too_large" });
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("UPSTREAM_ERROR", 502, { reason: "network_error" }, { cause: error });
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError("UPSTREAM_ERROR", 502, { reason: "invalid_json" }, { cause: error });
  }
}
