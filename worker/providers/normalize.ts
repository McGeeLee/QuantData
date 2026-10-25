import type { MarketBar } from "../domain/types";
import { isIsoDate } from "../lib/dates";

export function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function createBar(values: {
  date: string | null;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume: unknown;
}): MarketBar | null {
  const open = numberOrNull(values.open);
  const high = numberOrNull(values.high);
  const low = numberOrNull(values.low);
  const close = numberOrNull(values.close);
  const volume = numberOrNull(values.volume);
  if (!values.date || !isIsoDate(values.date) || open === null || high === null || low === null || close === null) return null;
  if (high < Math.max(open, low, close) || low > Math.min(open, close)) return null;
  return {
    date: values.date,
    open,
    high,
    low,
    close,
    volume: volume !== null && volume >= 0 ? volume : null,
  };
}

export function sortedBars(values: Array<MarketBar | null>): MarketBar[] {
  const byDate = new Map<string, MarketBar>();
  for (const value of values) if (value) byDate.set(value.date, value);
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}
