import { z } from "zod";
import type { MarketProvider } from "../domain/types";
import { AppError } from "../lib/app-error";
import { yahooEpochSeconds } from "../lib/dates";
import { fetchUpstream, readJson } from "../lib/upstream-fetch";
import { createBar, sortedBars } from "./normalize";

const chartSchema = z.object({
  chart: z.object({
    result: z.array(z.object({
      meta: z.object({ exchangeTimezoneName: z.string().optional() }).optional(),
      timestamp: z.array(z.number()).optional(),
      indicators: z.object({
        quote: z.array(z.object({
          open: z.array(z.number().nullable()).optional(),
          high: z.array(z.number().nullable()).optional(),
          low: z.array(z.number().nullable()).optional(),
          close: z.array(z.number().nullable()).optional(),
          volume: z.array(z.number().nullable()).optional(),
        })).min(1),
      }).optional(),
    })).nullable(),
    error: z.unknown().nullable(),
  }),
});

export const yahooProvider: MarketProvider = {
  source: "yahoo",
  async fetch(query, context) {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(query.symbol)}`);
    url.search = new URLSearchParams({
      // Provider timestamps use exchange time. Fetch a UTC guard day on each
      // side, then the shared service filters normalized trading dates.
      period1: String(yahooEpochSeconds(query.start) - 86_400),
      period2: String(yahooEpochSeconds(query.end, true) + 86_400),
      interval: "1d",
      events: "history",
      includeAdjustedClose: "false",
    }).toString();

    const response = await fetchUpstream(url, { headers: { accept: "application/json" } }, context.fetcher, undefined, context.maxAttempts);
    const parsed = chartSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new AppError("UPSTREAM_ERROR", 502, { reason: "invalid_payload" });
    const providerError = parsed.data.chart.error;
    if (providerError) {
      if (typeof providerError === "object" && "code" in providerError && providerError.code === "Not Found") return [];
      throw new AppError("UPSTREAM_ERROR", 502, { reason: "provider_rejected_request" });
    }
    const result = parsed.data.chart.result?.[0];
    if (!result?.timestamp?.length) return [];
    const quote = result.indicators?.quote[0];
    if (!quote?.open || !quote.high || !quote.low || !quote.close) throw new AppError("UPSTREAM_ERROR", 502, { reason: "invalid_payload" });
    let dateFormat: Intl.DateTimeFormat;
    try {
      dateFormat = new Intl.DateTimeFormat("en", {
        timeZone: result.meta?.exchangeTimezoneName ?? "UTC",
        year: "numeric", month: "2-digit", day: "2-digit",
      });
    } catch {
      throw new AppError("UPSTREAM_ERROR", 502, { reason: "invalid_timezone" });
    }
    return sortedBars(result.timestamp.map((timestamp, index) => createBar({
      date: tradingDate(timestamp, dateFormat),
      open: quote.open?.[index],
      high: quote.high?.[index],
      low: quote.low?.[index],
      close: quote.close?.[index],
      volume: quote.volume?.[index],
    })));
  },
};

function tradingDate(timestamp: number, format: Intl.DateTimeFormat): string | null {
  const date = new Date(timestamp * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
