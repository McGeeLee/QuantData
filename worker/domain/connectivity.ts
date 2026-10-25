import { z } from "zod";
import { DataSourceSchema } from "./types";
import { isIsoDate } from "../lib/dates";

const SampleDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isIsoDate);

/** A manual observation from the Worker, never a claim of ongoing availability. */
export const ConnectionCheckSchema = z.object({
  source: DataSourceSchema,
  status: z.enum(["ok", "not_configured", "access_denied", "rate_limited", "quota_exceeded", "quota_unavailable", "timeout", "network_error", "no_data", "upstream_error"]),
  checkedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  cached: z.boolean(),
  nextCheckAt: z.string().datetime(),
  sample: z.object({
    symbol: z.string(),
    start: SampleDateSchema,
    end: SampleDateSchema,
    barCount: z.number().int().nonnegative().optional(),
    latestBarDate: SampleDateSchema.optional(),
  }),
  error: z.object({
    code: z.string(),
    upstreamStatus: z.number().int().min(100).max(599).optional(),
    providerCode: z.number().finite().optional(),
  }).optional(),
  requestId: z.string(),
});

export type ConnectionCheck = z.infer<typeof ConnectionCheckSchema>;
