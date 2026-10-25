import { z } from "zod";
import type { MarketProvider } from "../domain/types";
import { AppError } from "../lib/app-error";
import { normalizeDate } from "../lib/dates";
import { fetchUpstream, readJson } from "../lib/upstream-fetch";
import { createBar, sortedBars } from "./normalize";

const pricesSchema = z.array(z.object({
  date: z.string(),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  close: z.number().nullable(),
  volume: z.number().nullable().optional(),
}));

export const tiingoProvider: MarketProvider = {
  source: "tiingo",
  async fetch(query, context) {
    if (!context.tiingoKey) throw new AppError("SOURCE_NOT_CONFIGURED", 503);
    const url = new URL(`https://api.tiingo.com/tiingo/daily/${encodeURIComponent(query.symbol)}/prices`);
    url.search = new URLSearchParams({
      startDate: query.start,
      endDate: query.end,
      resampleFreq: "daily",
      format: "json",
    }).toString();
    const response = await fetchUpstream(url, {
      headers: {
        accept: "application/json",
        authorization: `Token ${context.tiingoKey}`,
      },
    }, context.fetcher, undefined, context.maxAttempts);
    const parsed = pricesSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new AppError("UPSTREAM_ERROR", 502, { reason: "invalid_payload" });
    return sortedBars(parsed.data.map((row) => createBar({
      date: normalizeDate(row.date),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    })));
  },
};
