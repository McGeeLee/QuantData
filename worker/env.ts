import type { ProviderBudgetNamespace } from "./services/provider-budget";

/** Provider secrets are optional runtime bindings set with `wrangler secret put`. */
export type RuntimeEnv = Omit<Env, "PUBLIC_ORIGIN" | "PROVIDER_BUDGET"> & {
  /** Non-secret canonical deployment origin, used for the MCP allowlist. */
  PUBLIC_ORIGIN: string;
  TUSHARE_TOKEN?: string;
  TIINGO_KEY?: string;
  /** Missing/unavailable protection must stop upstream calls. */
  PROVIDER_BUDGET?: ProviderBudgetNamespace;
};
