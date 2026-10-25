import { z } from "zod";
import { MarketDataResponseSchema, SourceStatusSchema, type DataSource, type Locale, type MarketDataResponse, type SourceStatus } from "../../worker/domain/types";

import { ConnectionCheckSchema, type ConnectionCheck } from "../../worker/domain/connectivity";

export class ApiClientError extends Error {
  constructor(readonly code: string, message = code, readonly requestId?: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiClientError";
  }
}

const ErrorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }) });
const SourcesSchema = z.object({ sources: z.array(SourceStatusSchema) });

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1_000;
  const delay = Math.max(0, Math.ceil(seconds));
  const retryAt = Date.now() + delay * 1_000;
  return Number.isFinite(delay) && Number.isFinite(new Date(retryAt).getTime()) ? delay : undefined;
}

async function jsonRequest<T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal, method: "GET" | "POST" = "GET"): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  // The Worker may make two ten-second attempts. Bound the complete browser wait.
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try {
    const response = await fetch(url, { method, headers: { accept: "application/json" }, signal: controller.signal });
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    const blockedResponse = response.status === 401 || response.status === 403;
    let body: unknown;
    try {
      body = await response.json<unknown>();
    } catch {
      throw new ApiClientError(blockedResponse ? "SITE_REQUEST_BLOCKED" : "INVALID_RESPONSE", undefined, undefined, retryAfterSeconds);
    }
    if (!response.ok) {
      const error = ErrorResponseSchema.safeParse(body);
      if (error.success) throw new ApiClientError(error.data.error.code, error.data.error.message, error.data.error.requestId, retryAfterSeconds);
      throw new ApiClientError(blockedResponse ? "SITE_REQUEST_BLOCKED" : "INVALID_RESPONSE", undefined, undefined, retryAfterSeconds);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiClientError("INVALID_RESPONSE");
    return parsed.data;
  } catch (cause) {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    if (timedOut) throw new ApiClientError("REQUEST_TIMEOUT");
    if (cause instanceof ApiClientError) throw cause;
    throw new ApiClientError("NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function fetchSources(lang: Locale, signal?: AbortSignal): Promise<SourceStatus[]> {
  const body = await jsonRequest(`/api/v1/sources?lang=${encodeURIComponent(lang)}`, SourcesSchema, signal);
  return body.sources;
}

export async function fetchMarketData(input: {
  source: string;
  symbol: string;
  start: string;
  end: string;
  lang: Locale;
}, signal?: AbortSignal): Promise<MarketDataResponse> {
  const params = new URLSearchParams(input);
  const data = await jsonRequest(`/api/v1/market-data?${params.toString()}`, MarketDataResponseSchema, signal);
  // Chart libraries require unique ascending dates; do not render malformed data.
  if (data.meta.count !== data.bars.length || data.bars.some((bar, index) => index > 0 && bar.date <= data.bars[index - 1].date)) {
    throw new ApiClientError("INVALID_RESPONSE");
  }
  return data;
}


export async function checkSourceConnection(source: DataSource, lang: Locale, signal?: AbortSignal): Promise<ConnectionCheck> {
  const result = await jsonRequest(`/api/v1/sources/${source}/check?lang=${encodeURIComponent(lang)}`, ConnectionCheckSchema, signal, "POST");
  if (result.source !== source) throw new ApiClientError("INVALID_RESPONSE");
  return result;
}
