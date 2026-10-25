import { AppError } from "./app-error";

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function defaultDateRange(now = new Date()): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime());
  start.setUTCMonth(start.getUTCMonth() - 1);
  // Clamp to the previous month's last day when its corresponding day is absent.
  if (start.getUTCMonth() === end.getUTCMonth()) start.setUTCDate(0);
  return { start: isoDate(start), end: isoDate(end) };
}

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && isoDate(new Date(milliseconds)) === value;
}

export function validateDateRange(start: string, end: string): void {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new AppError("INVALID_DATE_RANGE", 400);
  }
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (
    !Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || isoDate(new Date(startMs)) !== start
    || isoDate(new Date(endMs)) !== end
    || startMs > endMs
  ) {
    throw new AppError("INVALID_DATE_RANGE", 400);
  }
  const fiveYears = DAY_MS * 366 * 5;
  if (endMs - startMs > fiveYears) throw new AppError("INVALID_DATE_RANGE", 400);
}

export function yahooEpochSeconds(date: string, includeEnd = false): number {
  const value = Date.parse(`${date}T00:00:00Z`) + (includeEnd ? DAY_MS : 0);
  return Math.floor(value / 1000);
}

export function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

export function normalizeDate(value: string | number): string | null {
  // Date parses some impossible ISO dates by rolling into the following month.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && !isIsoDate(value.slice(0, 10))) return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : isoDate(date);
}
