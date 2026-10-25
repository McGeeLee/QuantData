import { disclaimer, errorMessage, warningText } from "../../worker/lib/i18n";
import type { ErrorCode } from "../../worker/lib/app-error";
import { ApiClientError } from "./api";

export type UiLocale = "en" | "zh-CN";

const en = {
  tagline: "Public market data, shaped for people and models.",
  subtitle: "One Cloudflare Worker for a bilingual dashboard, normalized REST API, OpenAPI 3.1, and stateless MCP.",
  dashboard: "Dashboard",
  about: "About",
  openDashboard: "Open dashboard",
  marketQuery: "Market data query",
  sourceDetails: "Source status & connection checks",
  integrationTitle: "Use the data in your tools",
  aboutDashboardTitle: "Explore daily market data",
  aboutDashboardBody: "Choose a provider and symbol, compare daily prices, and see exactly when the data was retrieved.",
  aboutApiBody: "Use one normalized daily OHLCV contract with explicit source, cache and error information. OpenAPI describes the available endpoints.",
  aboutMcpBody: "Connect a compatible MCP client to read source configuration, market series and snapshots. Every tool is read-only.",
  documentation: "Docs",
  apiContract: "OpenAPI",
  mcp: "MCP endpoint",
  source: "Data source",
  symbol: "Symbol",
  start: "Start date",
  end: "End date",
  fetch: "Fetch market data",
  loading: "Loading market data…",
  sources: "Source status",
  configured: "Configured",
  unavailable: "Secret not configured",
  unofficial: "Unofficial endpoint",
  latestClose: "Latest close",
  change: "Change",
  changePercent: "Change %",
  volume: "Volume",
  candlestick: "Price & volume",
  closeHistory: "Closing price",
  dailyReturns: "Daily change %",
  noData: "No bars were returned for this request.",
  intro: "Choose a provider, enter its native symbol, and request up to five years of provider-native daily OHLCV data.",
  publicApi: "Public by design",
  cache: "1 hour edge cache",
  raw: "Daily · provider-native OHLCV",
  nativePrices: "Provider-native OHLC",
  priceBasis: "This service applies no additional price adjustment. Yahoo prices may already reflect stock splits; its adjclose series is not used.",
  disclaimer: "Data may be delayed or incomplete. Yahoo Chart is unofficial. This service does not provide investment advice.",
  examples: "Examples",
  apiExample: "API example",
  mcpExample: "MCP client URL",
  copy: "Copy",
  copied: "Copied",
  docsTitle: "Quant Data documentation",
  docsLead: "A compact contract for humans, applications, and large language models.",
  overview: "Overview",
  rest: "REST API",
  mcpTools: "MCP tools",
  localization: "Localization",
  limits: "Limits and behavior",
  back: "Back to dashboard",
  requestFailed: "Request failed",
  bars: "bars",
  initial: "Choose a source and symbol, then fetch daily historical data.",
  historical: "Daily historical data · not a live quote",
  previousClose: "vs. previous available close",
  fetchedAt: "Retrieved at (UTC)",
  latestBar: "Latest returned bar",
  freshnessNote: "Retrieval time is not the market update time. The latest daily bar may still be incomplete.",
  cacheHit: "Served from edge cache",
  cacheMiss: "Retrieved from provider",
  cacheUnavailable: "Edge cache unavailable",
  cacheAge: "Cache age at response",
  cacheTtl: "Cache TTL",
  seconds: "seconds",
  truncated: "Only the most recent bars are shown; the response was truncated.",
  providerUnits: "provider-native units",
  lots: "lots (100 shares per lot)",
  sourcesLoading: "Checking source configuration…",
  sourcesFailed: "Could not load source configuration.",
  sourceNote: "Configuration status does not verify provider availability or plan permissions.",
  networkError: "Could not reach the service. Check your connection and try again.",
  timeoutError: "The request timed out. Try again shortly.",
  invalidResponse: "The service returned an unexpected response. Please retry or check the deployment.",
  copyFailed: "Copy failed; select the text below.",
  retry: "Retry",
  skip: "Skip to content",
  connectionChecks: "Manual connection checks",
  connectionNote: "Checks run from the Cloudflare server using a fixed sample. A result describes that check only; it is not continuous monitoring. Results may be reused for five minutes.",
  checkConnection: "Check connection",
  checkingConnection: "Checking…",
  connectionUnchecked: "Not checked",
  checkTime: "Checked at (UTC)",
  checkDuration: "Duration",
  checkSample: "Sample",
  checkBarCount: "Bars returned",
  checkLatestBar: "Latest sample bar",
  checkReused: "Reused result · original check time shown",
  checkNext: "Next check allowed (UTC)",
  checkRequestId: "Request ID",
  checkUpstreamHttp: "Provider HTTP status",
  checkProviderCode: "Provider code",
  checkNoSecret: "Configure this provider's secret on the server before checking.",
  checkOk: "Sample check succeeded",
  checkNotConfigured: "Provider is not configured on the server.",
  checkAccessDenied: "Provider access denied. Access rules, credentials or plan permissions may prevent this sample request.",
  checkRateLimited: "The provider rate limited this sample request.",
  checkTimeout: "The provider did not respond in time.",
  checkNetworkError: "The Cloudflare server could not connect to the provider.",
  checkNoData: "The provider responded but returned no usable bars for this sample.",
  checkUpstreamError: "The provider returned an unexpected or unusable response.",
  quotaExceeded: "This project's free-tier protection has paused requests. Please try again later.",
  quotaUnavailable: "This project's free-tier protection is temporarily unavailable. Requests are paused; please try again later.",
  quotaCheckSkipped: "This check did not send a request to the provider.",
  quotaProtectionTitle: "Project free-tier protection",
  quotaProtectionScope: "All visitors share this project's counters. Counting starts when protection is enabled and does not include other applications.",
  quotaCheckCost: "One permitted, uncached check uses 1 provider request. Cache hits do not send provider requests (0).",
  quotaProtectionThreshold: "Project protection targets about 80% of the documented free-tier limits.",
  quotaProtectionDocs: "View project limits",
  siteBlocked: "The site request was blocked or intercepted. No provider check result was returned.",

} as const;

const zh: Record<keyof typeof en, string> = {
  tagline: "为用户与大模型而设计的公开行情数据。",
  subtitle: "一个 Cloudflare Worker 同时提供双语仪表盘、标准化 REST API、OpenAPI 3.1 与无状态 MCP。",
  dashboard: "行情面板",
  about: "项目介绍",
  openDashboard: "打开行情面板",
  marketQuery: "行情数据查询",
  sourceDetails: "数据源状态与连通性检查",
  integrationTitle: "在你的工具中接入数据",
  aboutDashboardTitle: "查看历史日线行情",
  aboutDashboardBody: "选择数据源和代码，查看每日价格变化，并确认数据实际抓取时间。",
  aboutApiBody: "统一的日线 OHLCV 契约明确返回来源、缓存和错误信息，OpenAPI 描述可用接口。",
  aboutMcpBody: "连接兼容的 MCP 客户端，读取数据源配置、日线序列与快照。所有工具均为只读。",
  documentation: "文档",
  apiContract: "OpenAPI",
  mcp: "MCP 端点",
  source: "数据源",
  symbol: "证券代码",
  start: "开始日期",
  end: "结束日期",
  fetch: "获取行情数据",
  loading: "正在获取行情数据…",
  sources: "数据源状态",
  configured: "已配置",
  unavailable: "尚未配置密钥",
  unofficial: "非官方接口",
  latestClose: "最新收盘价",
  change: "涨跌额",
  changePercent: "涨跌幅",
  volume: "成交量",
  candlestick: "K 线与成交量",
  closeHistory: "收盘价",
  dailyReturns: "每日涨跌幅",
  noData: "该请求没有返回日线数据。",
  intro: "选择数据源并输入其原生代码，可获取最长五年的供应商原生日线 OHLCV 数据。",
  publicApi: "完全公开",
  cache: "一小时边缘缓存",
  raw: "日线 · 供应商原生 OHLCV",
  nativePrices: "供应商原生 OHLC",
  priceBasis: "本服务不再额外复权。Yahoo 价格可能已做拆股调整；本服务不使用其 adjclose 序列。",
  disclaimer: "行情可能延迟或不完整。Yahoo Chart 为非官方接口。本服务不构成投资建议。",
  examples: "代码示例",
  apiExample: "API 示例",
  mcpExample: "MCP 客户端地址",
  copy: "复制",
  copied: "已复制",
  docsTitle: "Quant Data 文档",
  docsLead: "面向用户、应用与大语言模型的精简契约。",
  overview: "概览",
  rest: "REST API",
  mcpTools: "MCP 工具",
  localization: "本地化",
  limits: "限制与行为",
  back: "返回行情面板",
  requestFailed: "请求失败",
  bars: "条日线",
  initial: "请选择数据源并输入代码，然后获取历史日线数据。",
  historical: "历史日线数据 · 非实时行情",
  previousClose: "相较上一条可用收盘价",
  fetchedAt: "抓取时间（UTC）",
  latestBar: "最新返回日线",
  freshnessNote: "抓取时间不代表行情更新时间。最新日线可能尚未收盘，数据仍可能不完整。",
  cacheHit: "来自边缘缓存",
  cacheMiss: "本次从供应商抓取",
  cacheUnavailable: "边缘缓存不可用",
  cacheAge: "响应时缓存年龄",
  cacheTtl: "缓存有效期",
  seconds: "秒",
  truncated: "响应已截断，仅显示最近的日线。",
  providerUnits: "供应商原生单位",
  lots: "手（每手 100 股）",
  sourcesLoading: "正在查询数据源配置…",
  sourcesFailed: "无法加载数据源配置。",
  sourceNote: "配置状态不代表供应商当前可用，也不验证套餐权限。",
  networkError: "无法连接服务，请检查网络后重试。",
  timeoutError: "请求超时，请稍后重试。",
  invalidResponse: "服务返回了异常响应，请重试或检查部署配置。",
  copyFailed: "复制失败，请手动选择下方文本。",
  retry: "重试",
  skip: "跳转到正文",
  connectionChecks: "手动连通性检查",
  connectionNote: "检查由 Cloudflare 服务器使用固定样本发起。结果只代表该次检查，并非持续监控；结果可能复用五分钟。",
  checkConnection: "检查连通性",
  checkingConnection: "正在检查…",
  connectionUnchecked: "尚未检查",
  checkTime: "检查时间（UTC）",
  checkDuration: "耗时",
  checkSample: "检查样本",
  checkBarCount: "返回日线条数",
  checkLatestBar: "样本最新日线",
  checkReused: "复用已有结果 · 显示原始检查时间",
  checkNext: "可再次检查时间（UTC）",
  checkRequestId: "请求编号",
  checkUpstreamHttp: "供应商 HTTP 状态",
  checkProviderCode: "供应商代码",
  checkNoSecret: "请先在服务器配置该数据源的密钥，再进行检查。",
  checkOk: "样本检查成功",
  checkNotConfigured: "服务器尚未配置此数据源。",
  checkAccessDenied: "供应商拒绝访问。访问规则、凭据或套餐权限均可能导致该样本请求被拒绝。",
  checkRateLimited: "供应商对该样本请求进行了限流。",
  checkTimeout: "供应商未在限定时间内响应。",
  checkNetworkError: "Cloudflare 服务器无法连接供应商。",
  checkNoData: "供应商已响应，但该样本没有可用日线。",
  checkUpstreamError: "供应商返回了异常或无法使用的响应。",
  quotaExceeded: "项目免费额度保护已暂停请求，请稍后重试。",
  quotaUnavailable: "项目免费额度保护暂不可用，已暂停请求，请稍后重试。",
  quotaCheckSkipped: "本次检查未向供应商发送请求。",
  quotaProtectionTitle: "项目免费额度保护",
  quotaProtectionScope: "本项目所有访客共享计数；从保护启用时开始统计，不覆盖其他应用。",
  quotaCheckCost: "获准执行且未命中缓存的检查计1次供应商请求；缓存命中计0次，不向供应商发请求。",
  quotaProtectionThreshold: "项目保护阈值约为文档所列免费上限的80%。",
  quotaProtectionDocs: "查看项目限额",
  siteBlocked: "站点请求被拦截或拒绝，未返回供应商检查结果。",

};

export const translations = { en, "zh-CN": zh } as const;

export function detectLocale(): UiLocale {
  const stored = readPreference("quant-data-locale");
  if (stored === "en" || stored === "zh-CN") return stored;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

// Storage may be disabled in private/embedded browsers. Preferences are optional.
export function readPreference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function savePreference(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Keep the in-memory preference. */ }
}

const errorCodes: ErrorCode[] = ["INVALID_REQUEST", "INVALID_SYMBOL", "INVALID_DATE_RANGE", "SOURCE_NOT_CONFIGURED", "NOT_FOUND", "ROUTE_NOT_FOUND", "METHOD_NOT_ALLOWED", "RATE_LIMITED", "UPSTREAM_RATE_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_ERROR", "INTERNAL_ERROR"];

export function describeError(cause: unknown, locale: UiLocale): string {
  const t = translations[locale];
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string") {
    const known = errorCodes.find((code) => code === cause.code);
    const message = cause.code === "QUOTA_EXCEEDED" ? t.quotaExceeded
      : cause.code === "QUOTA_UNAVAILABLE" ? t.quotaUnavailable
      : known ? errorMessage(locale, known)
      : cause.code === "REQUEST_TIMEOUT" ? t.timeoutError
      : cause.code === "SITE_REQUEST_BLOCKED" ? t.siteBlocked
      : cause.code === "NETWORK_ERROR" ? t.networkError
      : t.invalidResponse;
    return cause instanceof ApiClientError && cause.requestId ? `${message} (${cause.requestId})` : message;
  }
  return t.networkError;
}

export function localizeWarning(warning: string, locale: UiLocale): string {
  for (const original of ["en", "zh-CN"] as const) {
    if (warning === disclaimer[original]) return disclaimer[locale];
    for (const key of ["yahoo", "raw", "tiingo"] as const) {
      if (warning === warningText(original, key)) return warningText(locale, key);
    }
  }
  return warning;
}
