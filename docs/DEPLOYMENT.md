# Build, redeploy, and demonstrate QuantData

[中文](./DEPLOYMENT.zh-CN.md) · [README](../README.md)

This is a React/Vite frontend and Hono API packaged as one Cloudflare Worker, with SQLite Durable Objects for persistent provider budgets. The first budget release requires a Durable Object migration. Local checks do not deploy anything. The deployment commands below are for the operator to run when ready.

## Reproduce the local build

Use Node.js 24.19.0 from `.nvmrc` and npm (the toolchain requires `^22.18.0 || >=24.11.0`), then run from the repository root:

```bash
# If you use nvm:
nvm install
nvm use
node --version
npm --version
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm ci` uses the committed `package-lock.json`; do not replace it with a general dependency upgrade. `npm run check` runs lint, TypeScript, unit/contract tests, the generated Worker-type check, the production build, a Wrangler dry run, and a real local HTTP runtime regression. The dry run prepares the deployment bundle without uploading it. If you edit `wrangler.jsonc`, run `npm run cf-types` and review the generated type diff before running the checks again.

Run `npm run build && npm run test:runtime` to check the current production bundle and start an isolated local workerd with empty credentials and a temporary port. It verifies that diagnostics accept empty POST requests, including zero-length and empty chunked bodies, while rejecting non-empty bodies. It contacts neither production nor providers and cleans up its own process. This covers incoming HTTP body semantics that in-memory Node requests and frontend API fixtures cannot replace. The runtime suite also exercises real local SQLite Durable Objects: concurrent requests cannot overspend, settlement is idempotent, provider budgets stay independent, and restarting workerd preserves usage. It additionally exercises the actual workerd fetch implementation against a local HTTP fixture: GET/POST work, redirects are not followed, and rejected budgets send no request. Native RequestInit behavior must not be replaced by a mock in this regression. Workers supports redirect: manual, not redirect: error. Finally, the built ASSETS binding is checked for direct navigation and refresh of `/`, `/about`, and both documentation pages, while API paths must remain JSON.

The browser suite runs against a separate client-only Vite server with API fixtures. It verifies UI behavior, including failures and mobile layout; it does **not** prove Yahoo, Tushare, or Tiingo access. Unit provider and MCP tests also use controlled responses. To try the real local Worker, use an unused port:

```bash
npm run dev -- --host 127.0.0.1 --port 5183 --strictPort
```

Open the printed local URL. `--strictPort` fails if that port is occupied, leaving other projects alone. This development server uses the real provider adapters, so a market query may use provider quota or fail due to network/provider restrictions. Local Durable Object storage is separate from production: real local requests using the same credentials are not included in the production budget. Prefer the fixture suites unless intentionally verifying a provider.

Yahoo does not require a key. Tushare and Tiingo are optional: create `.dev.vars` from `.env.example` only if the local file does not already exist, and add only credentials you intend to use. Keep it ignored. Never put provider secrets in `VITE_*` variables, source files, screenshots, or browser storage.

## Free-tier budgets and test costs

Keep this deployment on **Cloudflare Workers Free** and use only the **SQLite** Durable Object backend. Free-plan limits stop affected operations when exhausted; do not switch to Paid, add paid resources, or remove budget enforcement to continue testing. Check the actual account plan and usage in Cloudflare's dashboard before deployment. A successful login or upload does not verify billing status; if a billing API read returns 403, record that plan verification remains dependent on the account owner's dashboard. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Durable Objects Free availability and limits](https://developers.cloudflare.com/durable-objects/platform/pricing/).

| Provider | Official entry-level allowance | Conservative project cap |
| --- | --- | --- |
| Tiingo Starter | 50 requests/hour, 1,000/day, 500 distinct symbols/month, 1 GB/month | 40/hour, 800/24 hours, 400 distinct symbols and 800,000,000 accounted bytes/31 days |
| Tushare daily data at 120 points | 50/minute, 8,000/day; the listed tier costs ¥0 | 40/minute, 6,400/24 hours |
| Yahoo Chart | No published free allowance is asserted for this unofficial endpoint | Project policy: 1/minute, 100/24 hours |

Sources: [Tiingo pricing](https://www.tiingo.com/about/pricing), [Tiingo quota/reset overview](https://www.tiingo.com/documentation/general/overview), and [Tushare permission/frequency table](https://tushare.pro/document/1?doc_id=290). Tushare points confer access and are not deducted per request; credentials still need the required permission ([points explanation](https://tushare.pro/document/1?doc_id=13)). Provider plans, actual remaining usage, and data-display permissions must be checked in their own dashboards.

Before **every actual fetch attempt**, REST market data, snapshots, MCP, and manual checks reserve allowance in the same per-provider SQLite Durable Object. Cache hits use zero provider attempts; failures and retries remain counted. A fresh manual check makes at most one attempt, while an uncached market query may make two for network errors or HTTP 502–504 if budget remains. A provider HTTP 429 is returned immediately without another attempt. Missing credentials and refused budget approval make no provider request. The app does not automatically switch to another provider after a failure or quota limit.

Tiingo attempts reserve **6 MiB** each. A fully read HTTP 2xx response of at most **5 MiB** settles to actual response-body bytes plus **16 KiB**, independently of subsequent data validation. Failed fetches, non-2xx, canceled, oversized, unknown, or unsettled attempts retain the full reservation. Request limits use conservative rolling buckets: minute/hour windows can retain up to an extra minute, 24-hour windows up to an extra hour, and the 31-day byte window up to an extra day. Distinct symbols use exact last-seen times over 31 days. This is a project budget, not a replica of supplier accounting or a guarantee of an account-wide zero bill.

Fixture unit/browser tests and the isolated local HTTP regression make **zero real supplier calls**. Packaging/dry-run also makes no supplier calls. Real local or deployed tests can consume allowance; cached deployed responses still use Cloudflare resources even though they do not contact a provider. The guard cannot recover usage before its installation or account usage by another app, local server, independent Worker, or separately created namespace. Check official usage before a real probe and keep tests manual and bounded.

Budget exhaustion returns `QUOTA_EXCEEDED` (429 with `Retry-After`); missing or failed approval returns `QUOTA_UNAVAILABLE` (503). Connectivity diagnostics report `quota_exceeded` or `quota_unavailable` within their HTTP 200 diagnostic body. Stop and wait or restore the budget service; do not bypass protection. If settlement alone fails after data was obtained, the response may succeed while the full reservation stays charged to the project budget.

## Review deployment configuration

| Setting | What to verify |
| --- | --- |
| `name` | `quant-data` updates that Worker in the selected Cloudflare account. Change it only if you intend a separate Worker. |
| `vars.PUBLIC_ORIGIN` | Currently `https://quantdata.mcgeelee.com`. For your own deployment, set the exact public origin with no path, query, or credentials. The MCP allowlist uses its hostname. |
| `routes` | The current `{ "pattern": "quantdata.mcgeelee.com", "custom_domain": true }` entry binds that hostname during deployment. Replace it with a hostname in your own active Cloudflare zone, or remove `routes` when using only your default Workers address. Check for existing DNS and Worker assignments before attaching a hostname. |
| `workers_dev` | Explicitly `true` to retain the default address for the dashboard and REST API alongside the custom domain. MCP clients use the configured canonical domain. |
| `vars.APP_VERSION` | Keep the displayed service version consistent with the release you are preparing. |
| `compatibility_date`, `nodejs_compat` | Keep `2026-08-08`, the newest date supported by the locked workerd build. The former `2026-08-10` prevented reproducible local startup. Test runtime/dependency updates together. |
| `ASSETS` | The Vite plugin produces the frontend and Worker build. Preserve the SPA fallback and `run_worker_first` API/MCP paths. |
| `MARKET_RATE_LIMIT` | Preserve the binding name. Its `namespace_id` is an account-local identifier, not a secret; use a distinct ID if creating an independent limiter in the same account. The configured 60/minute limit is per location and is not a billing cap. |
| `SOURCE_CHECK_RATE_LIMIT` | Preserve the separate diagnostic limiter and its separate namespace: approximately one fresh check per source per Cloudflare location per 60 seconds. The diagnostic cache is checked first; this is not a strict global quota or free-tier guarantee. |
| `PROVIDER_BUDGET` | Required Durable Object binding to exported class `ProviderBudget`, using SQLite. Each stable provider name selects one persistent object shared across all request paths and edge locations in this deployment. |
| `migrations` | Preserve `{ "tag": "provider-budget-v1", "new_sqlite_classes": ["ProviderBudget"] }`. The first release needs permission to create the SQLite namespace. Do not delete or rename its class/namespace/provider names to reset usage. |
| `VERSION_METADATA` | Supplies version information for `/healthz` and MCP resources and isolates diagnostic caches by Worker version. Configuration or secret updates deployed as a new version invalidate earlier observations. |
| `TUSHARE_TOKEN`, `TIINGO_KEY` | Optional Worker secrets. An absent secret disables that source; a present secret does not prove account entitlement or upstream availability. |

The dashboard examples, REST discovery, OpenAPI server URL, and LLM discovery links follow the URL being used. MCP deliberately uses the explicit `PUBLIC_ORIGIN` allowlist instead of trusting arbitrary incoming Host headers. Localhost/loopback and MCP Inspector browser origins remain allowed. This deployment retains `https://quant-data.mcgeelee.workers.dev` for the dashboard and REST API; MCP clients must use `https://quantdata.mcgeelee.com/mcp`. If you serve both a custom domain and a workers.dev address in your own deployment, use its configured canonical address for MCP clients. Do not set an Origin wildcard to work around a configuration error.

Changing `PUBLIC_ORIGIN` alone does not provision DNS or attach a custom domain. The `routes` entry with `custom_domain: true` performs that attachment during `wrangler deploy`; Cloudflare manages its DNS record and certificate. For a fresh deployment, replace or remove the repository's `quantdata.mcgeelee.com` route and use a hostname you control, then set `PUBLIC_ORIGIN` to the intended address. Never deploy the original domain entry into another account. The SQLite budget Durable Object is required; no KV, D1, or R2 is required. The Cache API is opportunistic and local to Cloudflare locations; repeat requests are not guaranteed to hit the same cache. Budget objects are selected by provider name, independently of Worker version or secret value, so redeployment and key rotation preserve counters even when diagnostic caches expire.

## Deploy when ready

First verify Workers Free, the target account, and the intended existing Worker in the dashboard. Authenticate locally if needed:

```bash
npx wrangler login
npx wrangler whoami
```

If you need Tushare/Tiingo, configure only the required secret using its interactive prompt, or the target Worker's dashboard. Do not put a secret value directly into a command:

```bash
npx wrangler secret put TUSHARE_TOKEN
npx wrangler secret put TIINGO_KEY
```

After any configuration edit, regenerate types (including the exported `ProviderBudget` class and binding) and rerun local checks. The first deployment must successfully apply the SQLite migration; if permissions or plan constraints prevent it, stop that deployment and fix the access/configuration while retaining the guard. Do not deploy a version with the binding removed or an unguarded provider path. Then deploy deliberately:

```bash
npm run cf-types
npm run check
npm run test:e2e
npm run deploy
```

`npm run deploy` runs a fresh Vite build before `wrangler deploy`. The Vite plugin writes an output configuration that Wrangler discovers; avoid deploying a stale build after editing configuration. A successful dry run only validates packaging, not credentials, provider access, custom-domain routing, or production cache behavior.

For a deliberately configured Workers Builds connection, use the intended repository/branch, root `/`, install `npm ci`, build `npm run build`, deploy `npx wrangler deploy`, and Node.js 24.19.0. Verify the actual trigger settings in Cloudflare: a push triggers deployment only when that integration is configured and enabled. The repository alone cannot prove an active build connection.

## Check the deployed service

Set the exact URL printed by deployment (the address below is a placeholder):

```bash
QUANT_DATA_ORIGIN='https://your-worker.your-subdomain.workers.dev'
curl --fail-with-body "$QUANT_DATA_ORIGIN/healthz"
curl --fail-with-body "$QUANT_DATA_ORIGIN/api/v1/sources?lang=en"
curl --fail-with-body "$QUANT_DATA_ORIGIN/openapi.json"
curl --fail-with-body --get "$QUANT_DATA_ORIGIN/api/v1/market-data" \
  --data-urlencode 'source=yahoo' \
  --data-urlencode 'symbol=AAPL' \
  --data-urlencode 'lang=en'
```

Confirm the frontend, `/docs/en`, `/docs/zh-CN`, `/llms.txt`, and `/llms-full.txt` use your deployment URL. Connect a Streamable HTTP MCP client to your canonical `/mcp`, list tools, and read `quant-data://api/openapi`. Test each configured provider separately with a valid native symbol. Keep a failing provider marked as unverified and inspect its stable error code/request ID; do not replace failure with invented quotes.

For a successful query inspect `latestBarDate`, `fetchedAt`, `cache.status`, `cache.ageSeconds`, warnings, and volume units. Query again to exercise caching, while allowing for per-location misses. A weekend, holiday, historic selected range, delayed source, or still-forming daily candle can explain a date older than today. A recent fetch timestamp is not evidence of a recent trade. Check blank/invalid input, unknown symbols, source failures, rapid clicks, language switching, and phone layout against this deployed version before sharing it.

### Check a source manually

Use the dashboard check button or issue the following single request explicitly; do not add it to a polling job. It has no body and does not accept a custom symbol or date range:

```bash
curl --request POST --fail-with-body \
  "$QUANT_DATA_ORIGIN/api/v1/sources/yahoo/check?lang=en"
```

Replace the source path segment for Tushare/Tiingo if desired; missing credentials prevent a provider request. A fresh check runs once from the deployed Worker for a fixed symbol over the most recent calendar month, bypasses the market-data cache, and returns neither prices nor raw provider errors. Inspect `status`, `checkedAt`, `durationMs`, `cached`, `nextCheckAt`, and sanitized error codes, not HTTP 200 alone.

Normal diagnostic results are cached for 300 seconds; a longer provider or project-budget `Retry-After` can extend the wait. Cache hits retain the original observation time and duration without testing the provider again. Endpoint HTTP 429 is the service's diagnostic limiter; wait for `Retry-After`. In an HTTP 200 diagnosis, `rate_limited` means provider throttling, `quota_exceeded` means the shared project budget blocked the attempt, and `quota_unavailable` means budget approval was unavailable. Diagnose absent/expired credentials, entitlement, network failures, and limits from the result rather than attributing it to the user's home IP. `ok` confirms one fixed sample, not continuous availability or access to every symbol.

A deployment management API can confirm which version is active, not successful public routing or provider acceptance. If edge policy blocks public verification, record it as unverified; do not present management metadata or mocked tests as real provider success.

## Portfolio walkthrough

1. Explain the scope: one Worker, three provider adapters, one normalized contract, browser + REST + read-only MCP.
2. Query a valid daily series, point out the provider, latest returned trading date, fetch time, cache state, provider-native adjustment semantics, and units.
3. Switch language and show the same contract fields with localized UI/errors; resize to a phone viewport.
4. Show an invalid ticker format and an unconfigured provider. Manually check one source, distinguish a fresh observation from a cached result, and explain that it runs from the Worker without implying every provider remains online.
5. Open OpenAPI and copy the current-site REST/MCP examples. Retain provider attribution and explain that daily bars are not a live feed.

There is no sample-data mode in the shipped dashboard. Browser test fixtures are synthetic test data only. Do not present test screenshots as live supplier validation, or describe this project as a strategy, profit prediction, or trading execution system.

## Official references

- [Cloudflare Vite build output and deployment](https://developers.cloudflare.com/workers/vite-plugin/reference/migrating-from-wrangler-dev/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [MCP Host and Origin validation](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
