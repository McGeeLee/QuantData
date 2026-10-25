export const docs = {
  en: `# QuantData API and MCP

QuantData exposes public, read-only provider-native daily OHLCV data from Yahoo Finance Chart, Tushare Pro, and Tiingo. These are historical daily observations, not a real-time price feed. A source marked configured has the required configuration; this is not an upstream connectivity or entitlement check.

adjustment: raw means no additional adjustment by this service, not guaranteed unadjusted prices. Yahoo OHLC may already account for stock splits; the adapter does not use adjclose.

## REST API

- GET /api/v1 — discovery, stable operation IDs, links, and constraints
- GET /api/v1/sources — source availability and examples
- POST /api/v1/sources/{source}/check?lang=en — explicit manual connectivity diagnosis, no request body
- GET /api/v1/market-data?source=yahoo&symbol=AAPL&start=2025-01-01&end=2025-12-31
- GET /api/v1/snapshot?source=yahoo&symbol=AAPL
- GET /openapi.json — OpenAPI 3.1 contract

Dates use YYYY-MM-DD. The default range is one calendar month: end defaults to today in UTC, and an omitted start is the same day of the preceding calendar month, clamped to that month's last day if necessary. This also applies when only end is supplied (for example, 2026-03-31 defaults to a start of 2026-02-28). The maximum range is five years. REST responses contain at most 2,000 bars. Use lang=en or lang=zh-CN, or the Accept-Language header.

Symbols are provider-native: Yahoo AAPL/BTC-USD/600519.SS, Tushare 600519.SH, and Tiingo AAPL. Invalid calendar dates and source-specific symbol formats return stable 400 errors. Every response includes X-Request-Id and X-API-Version. Honor Retry-After on 429 or upstream-rate-limit responses; do not retry unchanged 400 requests.

HTTP error responses use { error: { code, message, details?, requestId } }. Important codes: INVALID_REQUEST, INVALID_SYMBOL, INVALID_DATE_RANGE, NOT_FOUND, ROUTE_NOT_FOUND, METHOD_NOT_ALLOWED, RATE_LIMITED, QUOTA_EXCEEDED, QUOTA_UNAVAILABLE, SOURCE_NOT_CONFIGURED, UPSTREAM_RATE_LIMITED, UPSTREAM_TIMEOUT, UPSTREAM_ERROR, INTERNAL_ERROR.

## Manual connectivity checks

Only run POST /api/v1/sources/{source}/check when explicitly requested; do not automatically check or poll. The service uses AAPL for Yahoo/Tiingo or 600519.SH for Tushare over the latest calendar month (UTC today back to the preceding month's same day, clamped to month-end). A fresh check bypasses the market cache and makes at most one provider request, with no retry; missing credentials return not_configured without a provider call. No prices, secrets, or raw upstream errors are returned.

HTTP 200 means a diagnosis completed, not provider success. The top-level result has source; status (ok, not_configured, access_denied, rate_limited, quota_exceeded, quota_unavailable, timeout, network_error, no_data, upstream_error); checkedAt; durationMs; cached; nextCheckAt; sample with symbol/start/end and optional barCount/latestBarDate; optional error with code/upstreamStatus/providerCode; and requestId. An ok status confirms only this sample at the observed time.

Diagnostics have a separate 300-second cache, extended for longer upstream Retry-After. A hit preserves original checkedAt, durationMs, and sample, while requestId identifies the current request. Worker versions isolate caches, including configuration/secret updates deployed as new versions. After a cache miss, SOURCE_CHECK_RATE_LIMIT allows approximately one check per source per Cloudflare location per 60 seconds; this approximate limiter is separate from the centralized provider budget below. Endpoint HTTP 429 means the diagnostic limiter; honor Retry-After. HTTP 200 with status rate_limited means the provider throttled the probe. nextCheckAt is guidance, not an automatic schedule.

The observation concerns the Cloudflare Worker-to-provider path, not a user's home IP. Configuration or deployment success alone is not proof of provider connectivity.

## Project free-tier budgets

All visitors and REST/MCP/diagnostic requests share persistent provider counters. Cache hits cost zero provider calls. Every actual attempt, including failures and retries, reserves budget first. Missing or unavailable protection stops calls. Redeployments and secret changes do not reset counters. Tiingo caps: 40 per rolling hour, 800 per 24 hours, 400 distinct symbols and an 800,000,000-byte response budget per 31 days. Tushare: 40 per rolling minute, 6,400 per 24 hours. Yahoo: project-chosen 1 per minute and 100 per 24 hours, not an official allowance. Conservative overlapping time buckets may delay recovery.

Tiingo reserves 6 MiB per attempt. A complete successful response up to 5 MiB settles to body bytes plus 16 KiB; failed or incomplete responses retain the reservation. This is a conservative project budget, not a supplier billing meter. Counters begin on activation and cannot include historical or other-app account usage. Never infer the account's remaining allowance from these counters. QUOTA_EXCEEDED (429) pauses calls; honor retryAfterSeconds. QUOTA_UNAVAILABLE (503) fails closed. Diagnostic statuses quota_exceeded/quota_unavailable differ from upstream rate_limited. No automatic fallback or immediate retries.

## MCP

Connect a Streamable HTTP MCP client to POST /mcp. The endpoint is public and stateless. Call list_data_sources first, get_market_snapshot for a single latest observation, and get_market_data for a series. Resources: quant-data://docs/en, quant-data://docs/zh-CN, and quant-data://api/openapi.

Modern tools return concise text plus validated structuredContent. Legacy stateless clients also receive JSON text. Tool errors include a stable code, retryable flag, optional retryAfterSeconds, actionable hint, and requestId. Preserve meta.warnings, meta.attribution, meta.volumeUnit, and meta.truncated in downstream model answers.

meta.latestBarDate is the latest returned trading date. meta.fetchedAt is when the provider response was fetched, not the time of a trade; cache hits retain that timestamp. meta.cache reports status (hit, miss, unavailable), ttlSeconds (3600), and ageSeconds. A recent fetch does not imply recent market data. Missing volume or previous-close metrics remain null, not zero. An empty result returns NOT_FOUND; the service never substitutes generated quotes.

Market data can be delayed or incomplete. Yahoo Chart is unofficial and may change. Data provided by Tiingo must retain attribution. This service does not provide investment advice.`,
  "zh-CN": `# QuantData API 与 MCP

QuantData 通过公开只读接口提供 Yahoo Finance Chart、Tushare Pro 和 Tiingo 的供应商原生日线 OHLCV 数据。这是历史日线数据，不是实时行情。“已配置”只表示所需配置存在，不表示已验证上游连通性或账号权限。

adjustment: raw 表示本服务不做额外复权，不保证供应商价格未经调整。Yahoo OHLC 可能已按拆股调整，本适配器不使用 adjclose。

## REST API

- GET /api/v1 — 发现信息、稳定操作 ID、链接与限制
- GET /api/v1/sources — 数据源状态和代码示例
- POST /api/v1/sources/{source}/check?lang=zh-CN — 主动手动连通性诊断，无请求体
- GET /api/v1/market-data?source=yahoo&symbol=AAPL&start=2025-01-01&end=2025-12-31
- GET /api/v1/snapshot?source=yahoo&symbol=AAPL
- GET /openapi.json — OpenAPI 3.1 契约

日期格式为 YYYY-MM-DD。默认范围为最近一个日历月：end 默认 UTC 当天，省略 start 时取前一个日历月同日；该日不存在则取上月最后一天。仅传入 end 时也按此规则计算（例如 2026-03-31 默认从 2026-02-28 开始）。最长五年；REST 最多返回 2,000 条。可使用 lang=en、lang=zh-CN 或 Accept-Language 请求本地化消息。

代码使用数据源原生格式：Yahoo AAPL/BTC-USD/600519.SS、Tushare 600519.SH、Tiingo AAPL。无效日历日期和不符合数据源规则的代码返回稳定 400 错误。响应包含 X-Request-Id 与 X-API-Version；429 或上游限流时应遵循 Retry-After，不要原样重试 400。

HTTP 错误响应格式为 { error: { code, message, details?, requestId } }。主要错误码：INVALID_REQUEST、INVALID_SYMBOL、INVALID_DATE_RANGE、NOT_FOUND、ROUTE_NOT_FOUND、METHOD_NOT_ALLOWED、RATE_LIMITED、QUOTA_EXCEEDED、QUOTA_UNAVAILABLE、SOURCE_NOT_CONFIGURED、UPSTREAM_RATE_LIMITED、UPSTREAM_TIMEOUT、UPSTREAM_ERROR、INTERNAL_ERROR。

## 手动连通性检查

仅在明确要求时调用 POST /api/v1/sources/{source}/check，不自动检查或轮询。服务固定使用 Yahoo/Tiingo 的 AAPL 或 Tushare 的 600519.SH，查询最近一个日历月（UTC 今天到上月同日，月底不足则取最后一天）。新检查绕过行情缓存，至多一次供应商请求且不重试；缺密钥直接返回 not_configured，不调用供应商。不返回价格、密钥或原始上游错误。

HTTP 200 只表示诊断完成，不代表供应商成功。顶层对象包含 source；status（ok、not_configured、access_denied、rate_limited、quota_exceeded、quota_unavailable、timeout、network_error、no_data、upstream_error）；checkedAt、durationMs、cached、nextCheckAt；sample（symbol/start/end、可选 barCount/latestBarDate）；可选 error（code/upstreamStatus/providerCode）；requestId。ok 只确认此固定样本在观测时成功。

诊断独立缓存 300 秒，更长的上游 Retry-After 会延长等待；命中时保留原 checkedAt、durationMs 和样本，requestId 使用当前请求标识。缓存按 Worker 版本隔离，配置/密钥更新发布成新版本后旧诊断失效。先读取缓存，未命中后 SOURCE_CHECK_RATE_LIMIT 按数据源、Cloudflare 位置每 60 秒约允许一次检查，这层近似限流之外还有下方的集中供应商额度保护。端点 HTTP 429 表示诊断限流，应遵循 Retry-After；HTTP 200 的 status: rate_limited 表示供应商限流。nextCheckAt 只是重试时间提示，不代表会自动执行。

诊断观察 Cloudflare Worker 到供应商的路径，不能据此认定用户家庭 IP 有问题。配置存在或部署成功本身都不证明供应商连通。

## 项目免费额度保护

所有访客及 REST、MCP、诊断共用持久化供应商计数；缓存命中零次。每次实际尝试（包括失败和重试）先预留额度；保护缺失或异常时停止调用，重新部署或更新密钥不清零。Tiingo：滚动每小时 40 次、24 小时 800 次，31 天 400 个不同标的及 800,000,000 字节响应预算。Tushare：滚动每分钟 40 次、24 小时 6,400 次。Yahoo：项目自设每分钟 1 次、24 小时 100 次，不是官方额度。交叠时间桶保守计数，恢复可能稍晚。

Tiingo 每次预留 6 MiB，完整成功且不超过 5 MiB 的响应按正文加 16 KiB 结算；失败或不完整响应保留预留。这是项目保守预算，不是供应商账单计量。计数从启用起，不涵盖历史或其他应用用量，不能据此推断账户剩余额度。QUOTA_EXCEEDED（429）暂停请求并需遵循 retryAfterSeconds；QUOTA_UNAVAILABLE（503）表示保护不可用而停止调用。诊断状态 quota_exceeded / quota_unavailable 与上游 rate_limited 不同；不自动切换数据源或立即重试。

## MCP

将 Streamable HTTP MCP 客户端连接到 POST /mcp。端点公开、无状态。先调用 list_data_sources；单个最新值使用 get_market_snapshot；序列使用 get_market_data。资源：quant-data://docs/en、quant-data://docs/zh-CN 与 quant-data://api/openapi。

现代工具返回精简文本与经过验证的 structuredContent；旧版无状态客户端还会获得 JSON 文本。工具错误包含稳定错误码、retryable、可选 retryAfterSeconds、可执行 hint 与 requestId。模型下游回答必须保留 meta.warnings、meta.attribution、meta.volumeUnit 与 meta.truncated。

meta.latestBarDate 为返回的最新交易日期。meta.fetchedAt 为抓取供应商响应的时间，不是成交时间；缓存命中不刷新该时间。meta.cache 包含 status（hit、miss、unavailable）、ttlSeconds（3600）和 ageSeconds。刚抓取不代表行情刚更新。缺失的成交量或前收指标保留 null，不能当作零。空结果返回 NOT_FOUND；服务不会使用生成行情代替。

行情可能延迟或不完整。Yahoo Chart 是非官方接口，可能发生变更。Tiingo 数据必须保留署名。本服务不构成投资建议。`,
} as const;

export function llmsText(origin: string): string {
  const base = new URL(origin).origin;
  return `# QuantData

> Public bilingual market-data REST API and stateless MCP server on Cloudflare Workers.

- [English documentation](${base}/docs/en)
- [中文文档](${base}/docs/zh-CN)
- [OpenAPI 3.1](${base}/openapi.json)
- [API discovery](${base}/api/v1)
- [Full LLM context](${base}/llms-full.txt)
- MCP endpoint: ${base}/mcp
`;
}

export function llmsFullText(origin: string): string {
  return `${llmsText(origin)}\n---\n\n${docs.en}\n\n---\n\n${docs["zh-CN"]}\n`;
}
