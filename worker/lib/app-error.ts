export type ErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_SYMBOL"
  | "INVALID_DATE_RANGE"
  | "SOURCE_NOT_CONFIGURED"
  | "NOT_FOUND"
  | "ROUTE_NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "QUOTA_UNAVAILABLE"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: 400 | 404 | 405 | 429 | 500 | 502 | 503 | 504,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "AppError";
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("INTERNAL_ERROR", 500, undefined, { cause: error });
}

export function retryAfterSeconds(error: AppError): number | undefined {
  if (typeof error.details === "object" && error.details !== null && "retryAfterSeconds" in error.details) {
    const value = (error.details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.ceil(value);
  }
  return error.code === "RATE_LIMITED" ? 60 : undefined;
}
