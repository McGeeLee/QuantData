# Quant Data REST API

[中文](./API.zh-CN.md) · [OpenAPI 3.1](https://quantdata.mcgeelee.com/openapi.json) · [MCP guide](./MCP.md)

Canonical base URL: `https://quantdata.mcgeelee.com`. Substitute your own origin when redeploying; running OpenAPI and discovery links use the current site. See the [deployment guide](./DEPLOYMENT.md).

The public v1 API is read-only and requires no authentication. It returns ascending provider-native daily OHLCV data. Field names, types, operation IDs, and error codes are language-independent.

## Discovery and versioning

- `GET /api/v1` returns API links, operation IDs, and v1 constraints.
- `GET /openapi.json` is the machine-readable contract.
- Responses include `X-API-Version: v1` and `X-Request-Id`.
- Breaking response or parameter changes require a new URL version. Additive fields and endpoints may be introduced within v1.

## Endpoints

| Operation ID | Request | Purpose |
| --- | --- | --- |
| `getHealth` | `GET /healthz` | Health without probing providers or secrets |
| `discoverApi` | `GET /api/v1` | API discovery document |
| `listDataSources` | `GET /api/v1/sources` | Configuration, examples, warnings, attribution (no upstream probe) |
| `checkSourceConnection` | `POST /api/v1/sources/{source}/check` | Manual fixed-sample connectivity diagnosis; no market prices returned |
| `getMarketData` | `GET /api/v1/market-data` | Daily OHLCV, up to 2,000 bars |
| `getMarketSnapshot` | `GET /api/v1/snapshot` | Latest close and change metrics |

### Market query parameters

| Parameter | Required | Rules |
| --- | --- | --- |
| `source` | yes | `yahoo`, `tushare`, or `tiingo` |
| `symbol` | yes | Provider-native symbol; normalized to uppercase |
| `start` | no | Inclusive `YYYY-MM-DD`; defaults to one calendar month before `end`, clamped to the preceding month's last day if needed |
| `end` | no | Inclusive `YYYY-MM-DD`; defaults to today (UTC) |
| `lang` | no | `en` or `zh-CN`; when omitted, `Accept-Language` is used |

When both dates are omitted, the range ends today in UTC and starts on the same day of the preceding calendar month. When only `end` is supplied, the omitted `start` is calculated from that date using the same rule. For example, `end=2026-03-31` defaults to `start=2026-02-28`; this is a calendar-month range, not a fixed 30-day window.

The maximum date range is five years. Calendar dates are strict, so values such as `2026-02-31` are rejected.

| Source | Accepted examples | Notes |
| --- | --- | --- |
| Yahoo | `AAPL`, `BTC-USD`, `^GSPC`, `600519.SS` | Unofficial Chart endpoint |
| Tushare | `600519.SH`, `000001.SZ`, `430047.BJ` | Six digits plus `.SH`, `.SZ`, or `.BJ` |
| Tiingo | `AAPL`, `BRK-A` | Tiingo ticker; retain attribution |

## Example

```bash
curl --get 'https://quantdata.mcgeelee.com/api/v1/market-data' \
  --data-urlencode 'source=yahoo' \
  --data-urlencode 'symbol=AAPL' \
  --data-urlencode 'start=2026-01-01' \
  --data-urlencode 'end=2026-08-10' \
  --data-urlencode 'lang=en'
```

Response shape below uses **synthetic values for documentation**, not an actual AAPL quote:

```json
{
  "meta": {
    "source": "yahoo",
    "symbol": "AAPL",
    "interval": "1d",
    "adjustment": "raw",
    "volumeUnit": "provider-native units",
    "count": 1,
    "fetchedAt": "2026-08-10T00:00:00.000Z",
    "latestBarDate": "2026-08-07",
    "cache": { "status": "miss", "ttlSeconds": 3600, "ageSeconds": 0 },
    "truncated": false,
    "warnings": ["..."]
  },
  "bars": [
    { "date": "2026-08-07", "open": 99, "high": 102, "low": 98, "close": 100, "volume": 1000 }
  ]
}
```

`volume` may be `null`. Tushare volume is lots (100 shares per lot); other sources use provider-native units. Snapshot `previousClose`, `change`, and `changePercent` are `null` when only one bar is available.

`adjustment: "raw"` is retained as the v1 contract value and means **no additional adjustment by this service**. It does not guarantee that the provider's OHLC prices are unadjusted. Yahoo may already account for stock splits; the adapter uses Chart OHLC and does not use `adjclose`. See [Yahoo historical-price labels](https://finance.yahoo.com/quote/AAPL/history?filter=history&frequency=1d&interval=1d&period1=345423600&period2=1482361200).

## Provenance and freshness

Market series and snapshots share these `meta` fields:

| Field | Meaning |
| --- | --- |
| `source`, `symbol` | The provider queried and normalized native symbol |
| `latestBarDate` | Latest returned trading date, not the current system date |
| `fetchedAt` | UTC provider-fetch timestamp, unchanged on a cache hit |
| `cache.status` | `hit` means a valid cache read; `miss` means no hit; `unavailable` means the cache could not be used and the provider was queried. A `miss` does not promise a background cache write succeeded. |
| `cache.ttlSeconds` | Cache policy lifetime, 3600 seconds |
| `cache.ageSeconds` | Seconds since `fetchedAt`, not market-data delay |
| `count`, `truncated` | Returned count and whether only recent bars were retained |
| `warnings`, `attribution`, `volumeUnit` | Warnings, attribution, and units to retain downstream |

These are historical daily observations, not a real-time price stream. A configured source is not proof of connectivity or account entitlement. No valid bars returns `NOT_FOUND`, without generated replacements. A cache failure may query the selected provider only after the shared budget approves the attempt; provider failures remain explicit errors. The service does not automatically switch providers.

## Manual connectivity checks

```bash
curl --request POST \
  'https://quantdata.mcgeelee.com/api/v1/sources/yahoo/check?lang=en'
```

Use your own deployment origin. `source` must be `yahoo`, `tushare`, or `tiingo`; `lang` accepts `en` or `zh-CN`. Send no request body. The sample symbol and date range are chosen by the service, independently of the dashboard form: `AAPL` for Yahoo/Tiingo, `600519.SH` for Tushare. The range is the most recent calendar month: today in UTC back to the same day of the preceding month, clamped to its last day if needed. Each fresh check bypasses the market-data cache and makes at most one provider request, without an automatic retry. A missing required credential returns `not_configured` without a provider call. Listing sources does not trigger this check, and the dashboard does not poll it.

HTTP **200 means a diagnosis was produced**, not that the provider succeeded. The body is a top-level diagnostic object, not a market-data response:

| Field | Meaning |
| --- | --- |
| `source`, `status` | Source checked and one of the statuses below |
| `checkedAt`, `durationMs` | UTC observation start and elapsed milliseconds for that observation |
| `cached` | Whether a previous diagnostic was reused; original time, duration, and sample are retained |
| `nextCheckAt` | Earliest suggested next-check time in UTC; this is not an automatic check schedule |
| `sample.symbol`, `sample.start`, `sample.end` | Fixed probe symbol and inclusive date range |
| `sample.barCount`, `sample.latestBarDate` | Optional count/latest trading date from the probe; OHLCV values are not returned |
| `error.code`, `error.upstreamStatus`, `error.providerCode` | Optional sanitized code and numeric provider status/code; no raw provider error text or credentials |
| `requestId` | Identifier of this API request, including when serving a cached observation |

| `status` | Interpretation |
| --- | --- |
| `ok` | This fixed sample returned data at `checkedAt`; not a guarantee of ongoing availability or other symbols' permissions |
| `not_configured` | Required credential is absent; no provider request was sent |
| `access_denied` | Provider denied access; check provider credentials, entitlement, or access policy |
| `rate_limited` | Provider throttled the sample; respect `nextCheckAt` and any `Retry-After` |
| `quota_exceeded` | This project's persistent budget blocked the attempt; wait until `nextCheckAt`/`Retry-After` |
| `quota_unavailable` | Budget approval could not be obtained; no unapproved attempt is sent |
| `timeout` | Provider request or response reading exceeded its deadline |
| `network_error` | Network request failed from the Worker runtime |
| `no_data` | No valid daily bars were returned for the fixed sample |
| `upstream_error` | Other provider or response failure; use the sanitized code for diagnosis |

Provider diagnostics are cached separately for 300 seconds; a longer provider or project-budget `Retry-After` extends reuse and `nextCheckAt`. Cache hits do not send another provider request. The cache key includes the Worker version, so deploying configuration or secret changes as a new version invalidates the previous observation. This does **not** reset the persistent provider budget. Missing credentials are checked before cache access.

After the cache lookup, `SOURCE_CHECK_RATE_LIMIT` permits approximately one fresh check per source per edge location per 60 seconds, shared among callers. A check-endpoint **HTTP 429** is the service's diagnostic limiter, distinct from HTTP 200 with `status: rate_limited` or `quota_exceeded`; honor its `Retry-After`. This edge limiter is not a global provider budget. Every actual probe also requires the persistent budget below, shared with market queries, snapshots, and MCP. If either protection is unavailable, no unapproved probe is sent.

These observations concern the **Cloudflare Worker → provider** path, not the browser's direct network path. They cannot identify a problem with a user's home IP. A deployed version, a configured credential, or passing fixture tests alone does not establish successful production provider access.

## Shared provider budgets

Before each actual outbound attempt, `PROVIDER_BUDGET` records a reservation in a SQLite Durable Object selected by the stable provider name. All callers, edge locations, REST market/snapshot requests, MCP tools, and manual checks use the same per-provider counters in this deployment. Deployments and credential rotation do not reset them. Cache hits use zero provider requests. A fresh manual check makes at most one attempt; a market query can make at most two, with every retry counted. Failed or uncertain attempts remain counted. Missing or failed budget approval stops the attempt, and the service never automatically switches providers to work around a limit.

| Source | Project cap |
| --- | --- |
| Tiingo | 40 attempts/hour; 800/24 hours; 400 distinct symbols and 800,000,000 accounted bytes/31 days |
| Tushare | 40 attempts/minute; 6,400/24 hours |
| Yahoo | 1 attempt/minute; 100/24 hours; a project policy, not a published Yahoo allowance |

Windows are rolling and conservative, including entire overlapping buckets: minute/hour request windows can retain up to an extra minute, 24-hour request windows up to an extra hour, and the 31-day Tiingo byte window up to an extra day. Distinct-symbol history uses the exact last-seen time over 31 days.

Each Tiingo attempt reserves **6 MiB** before fetching. After a fully read HTTP 2xx response of at most **5 MiB**, the reservation settles to response-body bytes plus **16 KiB**, independently of subsequent data validation. Failed fetches, non-2xx, canceled, oversized, or unknown responses retain the full reservation. If settlement fails, the full reservation remains; already obtained data may still be returned. This is conservative project accounting, not Tiingo's billing meter or a guarantee of account-wide zero cost.

These caps sit below the documented [Tiingo Starter limits](https://www.tiingo.com/about/pricing) and [Tushare 120-point daily-data limits](https://tushare.pro/document/1?doc_id=290), but do not cover earlier use or other applications sharing the account. Tiingo's documented reset periods also differ from the project's rolling windows ([API overview](https://www.tiingo.com/documentation/general/overview)). Verify current plans, permissions, and usage in official dashboards. See [free-tier deployment and test costs](./DEPLOYMENT.md#free-tier-budgets-and-test-costs); do not upgrade to paid services or bypass protection to continue testing.

## Errors and client behavior

```json
{
  "error": {
    "code": "INVALID_SYMBOL",
    "message": "The symbol format is invalid for the selected data source.",
    "details": { "source": "tushare", "expected": "..." },
    "requestId": "..."
  }
}
```

| HTTP | Common codes | Retry? |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_SYMBOL`, `INVALID_DATE_RANGE` | Fix request |
| 404 | `NOT_FOUND` | Change symbol/range/source |
| 404/405 | `ROUTE_NOT_FOUND`, `METHOD_NOT_ALLOWED` | Correct route/method; inspect `Allow` |
| 429 | `RATE_LIMITED` | Honor `Retry-After` |
| 429 | `QUOTA_EXCEEDED` | Project budget blocked the attempt; honor `Retry-After`, do not automatically change provider |
| 502 | `UPSTREAM_ERROR` | Back off and retry |
| 503 | `SOURCE_NOT_CONFIGURED`, `UPSTREAM_RATE_LIMITED` | Configure/change source or honor `Retry-After` |
| 503 | `QUOTA_UNAVAILABLE` | Budget protection is unavailable; restore the binding/service before another provider attempt |
| 504 | `UPSTREAM_TIMEOUT` | Back off and retry |
| 500 | `INTERNAL_ERROR` | Retry once; report `requestId` if persistent |

Use exponential backoff with jitter for retryable failures. Never retry a 400 response unchanged. Error bodies use `Cache-Control: no-store`.

## Caching, limits, and CORS

- Successful normalized results are edge-cached for 3,600 seconds by source, symbol, range, and interval.
- Market calls have an approximate 60/minute limit for each anonymous IP/source pair in each edge location. Health, discovery, and docs are not subject to that application limiter; Cloudflare account/resource limits still apply.
- Each upstream connection attempt has a ten-second timeout; response-body reading has a separate ten-second deadline and 5 MiB cap. Market queries may retry network errors and HTTP 502–504 once if budget remains; manual checks do not retry. Provider HTTP 429 is returned immediately without another attempt. Long `Retry-After` delays are returned to clients.
- REST allows cross-origin `GET`/`OPTIONS`; the manual check route additionally allows `POST`/`OPTIONS`. It exposes `X-Request-Id`, `X-API-Version`, and `Retry-After`.

Market data may be delayed, incomplete, or unavailable. This service does not provide investment advice. Provider terms and redistribution rights remain the caller/deployer's responsibility.
