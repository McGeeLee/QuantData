import type { DataSource, MarketQuery } from "../domain/types";
import { AppError } from "./app-error";
import { defaultDateRange, isIsoDate, validateDateRange } from "./dates";

const symbolRules: Record<DataSource, { pattern: RegExp; expected: string }> = {
  yahoo: { pattern: /^[A-Z0-9.^=_-]{1,40}$/, expected: "AAPL, BTC-USD, ^GSPC, or 600519.SS" },
  tushare: { pattern: /^\d{6}\.(?:SH|SZ|BJ)$/, expected: "six digits plus .SH, .SZ, or .BJ (for example 600519.SH)" },
  tiingo: { pattern: /^[A-Z0-9._-]{1,30}$/, expected: "a Tiingo ticker such as AAPL or BRK-A" },
};

export type MarketQueryInput = {
  source: DataSource;
  symbol: string;
  start?: string;
  end?: string;
};

export function normalizeMarketQuery(input: MarketQueryInput, now = new Date()): MarketQuery {
  if (input.end !== undefined && !isIsoDate(input.end)) throw new AppError("INVALID_DATE_RANGE", 400);
  const defaults = defaultDateRange(input.end ? new Date(`${input.end}T00:00:00Z`) : now);
  const symbol = input.symbol.trim().toUpperCase();
  const rule = symbolRules[input.source];
  if (!rule.pattern.test(symbol)) {
    throw new AppError("INVALID_SYMBOL", 400, { source: input.source, expected: rule.expected });
  }
  const query = {
    source: input.source,
    symbol,
    start: input.start ?? defaults.start,
    end: input.end ?? defaults.end,
  };
  validateDateRange(query.start, query.end);
  return query;
}
