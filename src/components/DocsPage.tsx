import type { UiLocale } from "../lib/i18n";
import { translations } from "../lib/i18n";
import { SiteHeader } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";

export function DocsPage({ locale, onLocale }: { locale: UiLocale; onLocale: (locale: UiLocale) => void }) {
  const t = translations[locale];
  const zh = locale === "zh-CN";
  const origin = window.location.origin;
  return (
    <main id="main" className="docs-shell">
      <SiteHeader locale={locale} onLocale={onLocale} active="docs" />
      <article className="docs-content">
        <header><span className="eyebrow">DOCUMENTATION · V3</span><h1>{t.docsTitle}</h1><p>{t.docsLead}</p></header>
        <section><h2>{t.overview}</h2><p>{zh ? "服务运行在单个 Cloudflare Worker 上，所有接口公开、只读且无 OAuth。统一返回按日期升序的供应商原生日线 OHLCV。adjustment: raw 表示本服务不做额外复权；Yahoo 可能已按拆股调整，本适配器不使用 adjclose。" : "The service runs on one Cloudflare Worker. Every interface is public, read-only, and requires no OAuth. Provider-native daily OHLCV bars are normalized in ascending date order. adjustment: raw means no additional service adjustment; Yahoo may already reflect stock splits, and this adapter does not use adjclose."}</p></section>
        <section><h2>{t.rest}</h2>
          <div className="endpoint"><b>GET</b><code>/api/v1</code><span>{zh ? "API 发现" : "API discovery"}</span></div>
          <div className="endpoint"><b>GET</b><code>/api/v1/sources</code><span>{zh ? "数据源状态" : "Source status"}</span></div>
          <div className="endpoint"><b>POST</b><code>{"/api/v1/sources/{source}/check"}</code><span>{zh ? "手动连通性诊断" : "Manual connectivity check"}</span></div>
          <div className="endpoint"><b>GET</b><code>/api/v1/market-data</code><span>{zh ? "日线序列" : "Daily bars"}</span></div>
          <div className="endpoint"><b>GET</b><code>/api/v1/snapshot</code><span>{zh ? "最新快照" : "Latest snapshot"}</span></div>
          <pre><code>{`curl '${origin}/api/v1/market-data?source=yahoo&symbol=AAPL&lang=${locale}'`}</code></pre>
          <p>{zh ? "v1 使用稳定 operationId、X-API-Version 与 X-Request-Id。代码必须符合数据源格式；日期包含边界并严格校验真实日历日期。" : "v1 publishes stable operation IDs, X-API-Version, and X-Request-Id. Symbols must match the provider format; dates are inclusive and strictly calendar-validated."}</p>
        </section>
        <section id="source-checks"><h2>{zh ? "手动检查连通性" : "Manual connectivity checks"}</h2>
          <pre><code>{`curl --request POST '${origin}/api/v1/sources/yahoo/check?lang=${locale}'`}</code></pre>
          <p>{zh ? "无请求体，仅在用户主动操作时检查，不自动轮询。固定使用 Yahoo/Tiingo 的 AAPL 或 Tushare 的 600519.SH，查询最近一个日历月；新检查绕过行情缓存，至多一次供应商请求且不重试。缺密钥时不请求上游。不返回价格、密钥或原始上游错误。" : "Send no body. Checks run only on explicit user action, without polling. A fixed AAPL sample for Yahoo/Tiingo or 600519.SH for Tushare covers the latest calendar month. A fresh check bypasses the market cache and makes at most one provider request, without a retry. Missing credentials prevent an upstream call. No prices, secrets, or raw upstream errors are returned."}</p>
          <p>{zh ? "HTTP 200 表示诊断完成，应读取 status：ok、not_configured、access_denied、rate_limited、quota_exceeded、quota_unavailable、timeout、network_error、no_data 或 upstream_error。查看 checkedAt、durationMs、cached 和 nextCheckAt；只有 ok 确认该时间的固定样本成功，不保证持续可用或其他代码权限。" : "HTTP 200 means the diagnosis completed. Inspect status: ok, not_configured, access_denied, rate_limited, quota_exceeded, quota_unavailable, timeout, network_error, no_data, or upstream_error. Read checkedAt, durationMs, cached, and nextCheckAt. Only ok confirms this fixed sample succeeded at that time, not continuous availability or access to other symbols."}</p>
          <p>{zh ? "诊断独立缓存 300 秒，上游更长的 Retry-After 会延长等待；命中时保留原时间与耗时。先读缓存，未命中后每个数据源、每个 Cloudflare 位置每 60 秒约允许一次检查，这层限流之外，供应商调用还受下方集中额度保护。端点 429 需遵循 Retry-After。请求由 Cloudflare Worker 发出，不能据此归因于用户家庭 IP；配置存在不等于连通。" : "Diagnostics have a separate 300-second cache, extended for a longer upstream Retry-After; hits retain the original time and duration. The cache is checked first, followed by an approximate limit of one fresh check per source per Cloudflare location per 60 seconds, with separate centralized provider budget protection described below. Honor Retry-After on endpoint 429 responses. Requests originate from the Cloudflare Worker, so results cannot establish a problem with the user's home IP. Configuration is not connectivity."}</p>
        </section>
        <section id="quota-protection"><h2>{zh ? "免费额度保护" : "Free-tier budget protection"}</h2>
          <p>{zh ? "所有访客、行情、快照、MCP 和连通性检查共用服务端计数。获准执行的新检查调用供应商一次；缓存命中零次，失败与重试也计入。达到上限时先停止调用，计数服务不可用时同样暂停；重新部署或更新密钥不会清零。" : "All visitors, market queries, snapshots, MCP, and checks share server-side budgets. An allowed fresh check makes one provider call; cache hits make none. Failed attempts and retries count. Reaching a budget or losing the counter pauses calls; deployments and secret updates do not reset it."}</p>
          <ul>
            <li>{zh ? "Tiingo：滚动 1 小时 40 次、24 小时 800 次；31 天 400 个不同标的及 800 MB 响应预算。" : "Tiingo: 40 attempts per rolling hour, 800 per 24 hours; 400 unique symbols and an 800 MB response budget over 31 days."}</li>
            <li>{zh ? "Tushare：滚动 1 分钟 40 次、24 小时 6,400 次；调用不扣积分。" : "Tushare: 40 attempts per rolling minute and 6,400 per 24 hours; calls do not deduct points."}</li>
            <li>{zh ? "Yahoo：项目自设每分钟 1 次、24 小时 100 次；这不是 Yahoo 公布或保证的免费额度。" : "Yahoo: a project cap of one attempt per minute and 100 per 24 hours; these are not published or guaranteed Yahoo allowances."}</li>
          </ul>
          <p>{zh ? "窗口按时间桶保守计数，恢复时间可能稍晚。Tiingo 每次先预留 6 MiB；完整成功响应不超过 5 MiB 时按正文大小加 16 KiB 结算，失败或不完整响应保留预留。此流量预算并非供应商账单计量。计数从启用开始，不包括历史或其他应用用量；账户实际额度仍需查看供应商控制台。" : "Conservative time buckets can delay availability. Tiingo reserves 6 MiB per attempt; complete successful responses up to 5 MiB settle to body bytes plus 16 KiB, while failed or incomplete responses retain the reservation. This is a traffic budget, not a provider billing meter. Counters begin on activation and exclude earlier or other-app usage; consult provider dashboards for account totals."}</p>
          <p>{zh ? "QUOTA_EXCEEDED（429）表示项目保护暂停；QUOTA_UNAVAILABLE（503）表示保护服务不可用。连通性结果分别为 quota_exceeded / quota_unavailable，和供应商限流 rate_limited 不同。不要立即重复点击。" : "QUOTA_EXCEEDED (429) means the project guard paused calls; QUOTA_UNAVAILABLE (503) means the guard is unavailable. Connectivity results use quota_exceeded / quota_unavailable, distinct from provider rate_limited. Do not immediately repeat requests."}</p>
        </section>
        <section id="mcp"><h2>{t.mcpTools}</h2><p>{zh ? "将支持 Streamable HTTP 的 MCP 客户端连接到以下地址。默认兼容普通旧版无状态客户端。" : "Connect any Streamable HTTP MCP client to the URL below. Ordinary legacy stateless clients are supported by default."}</p><pre><code>{`${origin}/mcp`}</code></pre><ul><li><code>list_data_sources</code> — {zh ? "应首先调用" : "call first"}</li><li><code>get_market_data</code> — {zh ? "默认 120，最多 500 条" : "120 bars by default, up to 500"}</li><li><code>get_market_snapshot</code></li></ul><p>{zh ? "资源包括中英文指南和 quant-data://api/openapi。工具错误会返回 retryable、重试提示和 requestId。" : "Resources include bilingual guidance and quant-data://api/openapi. Tool errors include retryable, an action hint, and requestId."}</p></section>
        <section><h2>{zh ? "数据来源与时效" : "Data provenance and freshness"}</h2><p>{zh ? "这是历史日线，不是实时行情。latestBarDate 是最新返回的交易日期；fetchedAt 是抓取时间，缓存命中不会刷新它。cache.status 区分命中、未命中和缓存不可用；缓存最多保留一小时。刚抓取不代表市场刚更新。" : "These are historical daily bars, not real-time quotes. latestBarDate is the latest returned trading date; fetchedAt is the provider fetch time and stays unchanged on cache hits. cache.status distinguishes hits, misses, and an unavailable cache; entries last up to one hour. A recent fetch does not imply recent market data."}</p><p>{zh ? "数据源已配置不代表已通过连通性或权限检查。缺少成交量/前收指标时返回 null；没有行情返回 NOT_FOUND，不生成替代行情。" : "A configured source has not necessarily passed connectivity or entitlement checks. Missing volume or previous-close metrics remain null. No bars means NOT_FOUND, without generated replacement quotes."}</p></section>
        <section><h2>{zh ? "错误契约" : "Error contract"}</h2><p>{zh ? "HTTP 错误响应固定为 error.code、message、可选 details 与 requestId；HTTP 200 的连通性诊断使用上方独立结果格式。400 应修正请求；429 与可重试上游错误应遵循 Retry-After 并使用带抖动的指数退避。" : "HTTP error responses contain error.code, message, optional details, and requestId; HTTP 200 connectivity diagnoses use the separate result format above. Correct 400 requests; honor Retry-After and use jittered exponential backoff for 429 and retryable upstream failures."}</p><pre><code>{`{"error":{"code":"INVALID_SYMBOL","message":"…","requestId":"…"}}`}</code></pre></section>
        <section><h2>{t.localization}</h2><p>{zh ? "REST 接受 lang=zh-CN 或 Accept-Language；字段名、类型与错误码永不本地化。MCP 工具接受 lang 参数。" : "REST accepts lang=en or Accept-Language. Field names, types, and error codes never change by locale. MCP tools accept a lang argument."}</p></section>
        <section><h2>{t.limits}</h2><ul><li>{zh ? "默认最近一个日历月：结束日期为 UTC 当天，开始日期为上月同日；该日不存在则取上月最后一天。仅填写结束日期时也按此规则计算。最长五年；REST 最多 2,000 条。" : "One calendar month by default: the end is today in UTC; the start is the same day in the preceding month, clamped to its last day if needed. The same rule applies when only the end date is supplied. Five years maximum, and at most 2,000 REST bars."}</li><li>{zh ? "每个匿名 IP 与数据源每分钟 60 次；缓存一小时。" : "60 calls per anonymous IP and source per minute; one-hour edge cache."}</li><li>{zh ? "行情查询上游超时 10 秒，网络与 502–504 错误最多重试一次；手动检查仅一次尝试。" : "Market queries have a ten-second upstream timeout and one retry for network errors/HTTP 502–504; manual checks use one attempt."}</li></ul></section>
        <aside className="notice">{t.disclaimer}</aside>
      </article>
      <SiteFooter locale={locale} />
    </main>
  );
}
