import type { DataSource } from "../domain/types";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const MONTH_MS = 31 * DAY_MS;
export const TIINGO_RESERVED_BYTES = 6 * 1024 * 1024;
export const MAX_PROVIDER_BODY_BYTES = 5 * 1024 * 1024;
export const RESPONSE_OVERHEAD_BYTES = 16 * 1024;
export const PROVIDER_BODY_TIMEOUT_MS = 10_000;

export type BudgetReason = "minute_requests" | "hour_requests" | "day_requests" | "monthly_symbols" | "monthly_bytes";
export type ReservationResult =
  | { allowed: true; reservationId: string }
  | { allowed: false; retryAfterSeconds: number; reason: BudgetReason };
export type ReserveInput = { source: DataSource; symbol: string };
export type SettleInput = { reservationId: string; bytes: number };

export interface ProviderBudgetStub {
  reserve(input: ReserveInput): Promise<ReservationResult>;
  settle(input: SettleInput): Promise<void>;
}

export interface ProviderBudgetNamespace {
  /** Stable source name: shared across visitors, deployments and credential changes. */
  getByName(name: string): ProviderBudgetStub;
}

export type BudgetEnv = { PROVIDER_BUDGET?: ProviderBudgetNamespace };
export type RequestBudget = { windowMs: number; limit: number; reason: BudgetReason };

export const REQUEST_BUDGETS: Record<DataSource, readonly RequestBudget[]> = {
  tiingo: [
    { windowMs: HOUR_MS, limit: 40, reason: "hour_requests" },
    { windowMs: DAY_MS, limit: 800, reason: "day_requests" },
  ],
  tushare: [
    { windowMs: MINUTE_MS, limit: 40, reason: "minute_requests" },
    { windowMs: DAY_MS, limit: 6_400, reason: "day_requests" },
  ],
  // Yahoo publishes no applicable free quota: these are deliberately small project limits.
  yahoo: [
    { windowMs: MINUTE_MS, limit: 1, reason: "minute_requests" },
    { windowMs: DAY_MS, limit: 100, reason: "day_requests" },
  ],
};

export const TIINGO_SYMBOL_LIMIT = 400;
export const TIINGO_BYTE_LIMIT = 800_000_000;

export function bucketStart(now: number, width: number): number {
  return Math.floor(now / width) * width;
}

/** Include the entire bucket touching the rolling window; never release capacity early. */
export function rollingBucketStart(now: number, windowMs: number, width: number): number {
  return bucketStart(now - windowMs, width);
}

export function retryAfterBucket(now: number, firstBucket: number, windowMs: number, width: number): number {
  return Math.max(1, Math.ceil((firstBucket + width + windowMs - now) / 1_000));
}

export function normalizeBudgetSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized || normalized.length > 64 || !/^[A-Z0-9.^=_-]+$/.test(normalized)) {
    throw new Error("Invalid budget symbol");
  }
  return normalized;
}

export function settledTiingoBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_PROVIDER_BODY_BYTES) {
    throw new Error("Invalid settlement size");
  }
  return bytes + RESPONSE_OVERHEAD_BYTES;
}
