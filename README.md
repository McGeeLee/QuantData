# Quant Data

[中文说明](./README.zh-CN.md) · [Live dashboard](https://quantdata.mcgeelee.com/) · [Project introduction](https://quantdata.mcgeelee.com/about) · [API guide](./docs/API.md) · [MCP guide](./docs/MCP.md) · [Deployment guide](./docs/DEPLOYMENT.md) · [OpenAPI](https://quantdata.mcgeelee.com/openapi.json)

Quant Data is a bilingual market-data dashboard, REST API, OpenAPI 3.1 service, and stateless MCP server running in a single Cloudflare Worker. It normalizes Yahoo Finance Chart, Tushare Pro, and Tiingo into ascending, provider-native daily OHLCV bars.

> Historical daily data, not a real-time quote feed. Market data can be delayed, incomplete, or unavailable. Yahoo Chart is an unofficial endpoint and is not guaranteed to remain stable. This project does not provide investment advice.

## Features

- React 19 + Vite 8 dashboard with responsive Lightweight Charts
- `/` opens directly on the query form and charts; `/about` contains the introduction and API/MCP examples without making provider API requests. Detailed connection checks are collapsed by default on the dashboard.
- Hono + Zod/OpenAPI REST contract and stable localized errors
- MCP SDK v2 through Cloudflare Agents `createMcpHandler`
- Stateless Streamable HTTP with ordinary 2025 stateless-client compatibility
- English and Simplified Chinese UI, docs, messages, warnings, and MCP resources
- Source, latest returned trading date, provider fetch time, and cache hit/miss/age shown explicitly
- Manual source connectivity checks with sanitized results, observation time, and cache state; no automatic polling
- One-hour edge cache and approximate Cloudflare Rate Limiting at 60 requests/minute per anonymous IP/source and edge location
- Persistent per-provider budgets shared by REST, snapshots, MCP, and manual checks; requests stop when the budget is exhausted or unavailable
- Market queries use a ten-second upstream timeout and at most one budget-approved retry for network errors/HTTP 502–504; provider HTTP 429 and manual checks are not retried
- Secrets read only from Worker bindings—never returned or logged

## Public endpoints

| Endpoint | Description |
| --- | --- |
| `GET /` | Dashboard: query form, historical charts and optional connection diagnostics |
| `GET /about` | Project introduction and API/MCP integration examples |
| `GET /healthz` | Service version and Cloudflare deployment metadata |
| `GET /api/v1` | API discovery, links, operation IDs, and constraints |
| `GET /api/v1/sources` | Provider configuration, markets, examples, warnings, attribution; no upstream probe |
| `POST /api/v1/sources/{source}/check` | Manual fixed-sample connectivity diagnosis; no prices returned |
| `GET /api/v1/market-data` | Provider-native daily OHLCV; one calendar month by default, five years maximum, 2,000 bars maximum |
| `GET /api/v1/snapshot` | Latest close, previous close, change, change percentage, volume |
| `GET /openapi.json` | OpenAPI 3.1 machine contract |
| `POST /mcp` | Stateless Streamable HTTP MCP endpoint |
| `GET /docs/en` | English documentation |
| `GET /docs/zh-CN` | Chinese documentation |
| `GET /llms.txt` | Concise model discovery file |
| `GET /llms-full.txt` | Full bilingual model context |

### REST example

```bash
curl 'https://quantdata.mcgeelee.com/api/v1/market-data?source=yahoo&symbol=AAPL&start=2025-01-01&end=2025-12-31&lang=en'
```

`source` is one of `yahoo`, `tushare`, or `tiingo`. `start` and `end` are inclusive `YYYY-MM-DD` dates. Use `lang=en`, `lang=zh-CN`, or `Accept-Language`; field names, types, and error codes remain language-independent.

The default range is the most recent calendar month: `end` defaults to today in UTC, and an omitted `start` uses the same day in the preceding calendar month. If that day does not exist, it uses the month's last day (for example, March 31 → February 28 in a non-leap year). This also applies when only `end` is supplied.

HTTP error responses use this shape:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "The request parameters are invalid.",
    "requestId": "..."
  }
}
```

## MCP

Connect a Streamable HTTP client to:

```text
https://quantdata.mcgeelee.com/mcp
```

Example client configuration:

```json
{
  "mcpServers": {
    "quant-data": {
      "type": "http",
      "url": "https://quantdata.mcgeelee.com/mcp"
    }
  }
}
```

Tools:

- `list_data_sources` — provider availability and symbol examples
- `get_market_data` — defaults to the 120 most recent bars; accepts `limit` up to 500 and reports truncation
- `get_market_snapshot` — latest close and change metrics

Every tool is read-only and idempotent, has Zod input/output schemas, and returns concise text plus `structuredContent`. Resources are available at `quant-data://docs/en`, `quant-data://docs/zh-CN`, and `quant-data://api/openapi`.

The MCP handler validates Host and browser Origin headers against the configured `PUBLIC_ORIGIN`, local development, and MCP Inspector origins to prevent DNS rebinding. The endpoint intentionally has no authentication.

## Data-source behavior

| Source | Markets/examples | Secret | Notes |
| --- | --- | --- | --- |
| Yahoo Finance Chart | `AAPL`, `BTC-USD`, `600519.SS` | None | Unofficial endpoint; provider-native volume units |
| Tushare Pro | `600519.SH`, `000001.SZ` | `TUSHARE_TOKEN` | Volume is reported in lots (100 shares per lot) |
| Tiingo | `AAPL`, `TSLA` | `TIINGO_KEY` | Responses preserve “Data provided by Tiingo” attribution |

All sources expose only provider-native daily values in v1. `adjustment: "raw"` means the service applies no further adjustment; it is not a guarantee of unadjusted prices. Yahoo OHLC can already reflect stock splits; this adapter does not use Yahoo `adjclose` ([Yahoo price labels](https://finance.yahoo.com/quote/AAPL/history?filter=history&frequency=1d&interval=1d&period1=345423600&period2=1482361200)). `configured: true` reports configuration, not a provider connectivity, quota, or entitlement check. Missing values remain `null`; empty data returns `NOT_FOUND`, without synthetic replacement quotes. If a secret is absent, `/api/v1/sources` reports that provider as unconfigured and provider calls return `SOURCE_NOT_CONFIGURED` without revealing secret state in `/healthz`.

### Manual connectivity checks

Use a source's check button, or send a bodyless `POST /api/v1/sources/{source}/check?lang=en`. The check runs from the Cloudflare Worker, using a fixed daily sample (`AAPL` for Yahoo/Tiingo, `600519.SH` for Tushare) over the most recent calendar month, ending today in UTC and starting on the preceding month’s same day (clamped to its last day if needed). It bypasses the market-data cache and makes at most one provider request; a missing credential returns `not_configured` without contacting the provider. Checks are manual, with no polling; secrets and raw upstream errors are never returned.

HTTP 200 means the diagnosis completed: inspect `status`. Only `ok` confirms that sample worked at that time, not ongoing availability or access to other symbols. Diagnostic results have a separate 300-second cache, extended for a longer provider or project-budget `Retry-After`. Cache hits retain the original `checkedAt`/`durationMs`; `cached` and `nextCheckAt` show reuse and retry timing. After a miss, checks are limited to approximately one per source per edge location per 60 seconds; endpoint 429 responses require honoring `Retry-After`. Every actual provider attempt also passes the shared persistent budget. `quota_exceeded` means that project budget paused the check; `quota_unavailable` means its protection could not be reached. Results describe the Worker-to-provider path and cannot establish a problem with the user's home IP. See the [API guide](./docs/API.md#manual-connectivity-checks) for fields and statuses.

### Free-tier operation

Keep the deployment on **Cloudflare Workers Free with SQLite Durable Objects**. Default project caps are Tiingo 40 requests/hour, 800/24 hours, 400 distinct symbols and 800,000,000 accounted bytes/31 days; Tushare 40/minute and 6,400/24 hours; Yahoo 1/minute and 100/24 hours (a project choice, not a published Yahoo allowance). Cache hits use no provider allowance. Each actual attempt, including a retry or failed request, is counted; a manual probe uses at most one attempt, a market query at most two. No automatic switch to another provider occurs. A SQLite Durable Object per source preserves counters across deployments and key rotation. See the [budget and cost details](./docs/DEPLOYMENT.md#free-tier-budgets-and-test-costs) for conservative byte reservations and official plan references.

These caps cover this deployment's recorded requests, not earlier usage, other apps sharing credentials, or the whole account's bill. Verify current plans and usage in the official dashboards before real-provider tests. Budget exhaustion returns `QUOTA_EXCEEDED` (429); unavailable protection returns `QUOTA_UNAVAILABLE` (503), without sending the blocked attempt. Do not enable paid plans or bypass the guard to continue a test.

## Local development

Use the tested Node.js **24.19.0** in `.nvmrc` and npm. The locked toolchain requires Node.js `^22.18.0 || >=24.11.0`; older Node 22 releases are insufficient.

```bash
# If you use nvm:
nvm install
nvm use
npm ci
npm run dev -- --host 127.0.0.1 --port 5183 --strictPort
```

Yahoo needs no credential, but its unofficial endpoint can still fail or rate-limit. For optional Tushare/Tiingo access, create `.dev.vars` from `.env.example` only when that file does not already exist, then fill it locally. Never commit it or put provider secrets in `VITE_*` variables.

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

`check` runs lint, types, unit/contract tests, generated Worker-type verification, production build, and deployment dry run. Browser tests use API fixtures; they are not live provider acceptance. Real provider checks require the local Worker or deployed service. See the [deployment and demonstration guide](./docs/DEPLOYMENT.md) for the full procedure and limitations.

## Cloudflare deployment

Review `wrangler.jsonc` before deployment: the Worker name is `quant-data`, runtime compatibility is `2026-08-08` with `nodejs_compat`, and `vars.PUBLIC_ORIGIN` must match your intended public address. Preserve SPA assets, both Rate Limiting bindings, version metadata, and the required `PROVIDER_BUDGET` binding to the SQLite `ProviderBudget` class. Its initial `provider-budget-v1` migration must succeed; no D1, KV, or R2 is required.

When you are ready to deploy, follow [the operator guide](./docs/DEPLOYMENT.md) to verify the account, optional secrets, generated types, build, and target origin. `npm run deploy` builds first and then deploys the Worker. The configured `routes` entry attaches `quantdata.mcgeelee.com` as a custom domain during deployment. For your own deployment, replace or remove that entry and set `PUBLIC_ORIGIN` to your own address; changing `PUBLIC_ORIGIN` alone does not attach a domain or change DNS.

This README uses the canonical address `https://quantdata.mcgeelee.com`. The previous `https://quant-data.mcgeelee.workers.dev` address remains available for the dashboard and REST API; MCP clients must use `https://quantdata.mcgeelee.com/mcp`. Substitute your own origin for a fresh deployment. The running dashboard, docs, OpenAPI, and LLM discovery generate links for the current site; MCP allows the configured canonical origin. An enabled Workers Builds integration can deploy on a push to its configured branch—verify the actual Cloudflare settings rather than assuming `main` is linked.

## Portfolio demonstration

Show one real daily query, its provider/date/fetch-time/cache metadata, phone layout and language switching; then demonstrate input errors, an unconfigured source, OpenAPI and read-only MCP. State that this is a data integration project, not a real-time feed or trading system. Keep provider attribution visible. The [walkthrough](./docs/DEPLOYMENT.md#portfolio-walkthrough) separates synthetic test fixtures from real supplier verification.

## Architecture

```text
Browser / REST client / MCP client
                 │
        Cloudflare Worker
        ├── React SPA assets
        ├── Hono + OpenAPI API
        ├── stateless MCP v2 handler
        ├── rate limit + Cache API
        ├── SQLite Durable Object budgets per provider
        └── normalized provider layer
            ├── Yahoo Chart
            ├── Tushare HTTP API
            └── Tiingo REST API
```

The cache key contains source, normalized symbol, inclusive date range, and interval. Only successful normalized series are cached for 3,600 seconds. `meta.fetchedAt` remains the original provider fetch time on a hit; `meta.latestBarDate` is the newest returned trading date. `meta.cache` reports `status`, `ttlSeconds`, and `ageSeconds`. Cache failures may query the selected provider only after budget approval; no result is substituted from invented data. API and MCP share the same provider, budget, and error-mapping layer.

## Migration from v2

Version 3 is a full rewrite. The former Python, Streamlit, Pandas, Plotly, `yfinance`, `tushare`, and `tiingo` client implementation was removed. Behavior differences:

- one edge Worker replaces the Streamlit application and server-side DataFrame flow;
- browser, REST, OpenAPI, and MCP interfaces are first-class;
- upstream calls use direct HTTP adapters with explicit timeout/retry/error policy;
- only the previously active Yahoo, Tushare, and Tiingo daily provider-native paths are retained;
- AkShare, Binance placeholders, Python dependencies, and Streamlit configuration are not migrated.

## Attribution and terms

Provider data remains subject to each provider's terms. Yahoo Chart is unofficial. Tushare responses are attributed to Tushare. Tiingo responses include the required attribution. Deployers are responsible for ensuring their provider plans permit public redistribution.
