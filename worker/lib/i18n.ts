import type { ErrorCode } from "./app-error";
import type { Locale } from "../domain/types";

const messages: Record<Locale, Record<ErrorCode, string>> = {
  en: {
    INVALID_REQUEST: "The request parameters are invalid.",
    INVALID_SYMBOL: "The symbol format is invalid for the selected data source.",
    INVALID_DATE_RANGE: "The date range is invalid or exceeds five years.",
    SOURCE_NOT_CONFIGURED: "This data source is not configured on the server.",
    NOT_FOUND: "No market data was found for the requested symbol and date range.",
    ROUTE_NOT_FOUND: "The requested API route does not exist.",
    METHOD_NOT_ALLOWED: "This route does not support the requested HTTP method.",
    RATE_LIMITED: "The public rate limit has been exceeded. Try again shortly.",
    QUOTA_EXCEEDED: "This project's free-tier budget protection has paused provider requests. Try again after the indicated time.",
    QUOTA_UNAVAILABLE: "The project's budget protection is unavailable. Provider requests have been paused to protect the allowance.",
    UPSTREAM_RATE_LIMITED: "The upstream data provider is rate limiting requests.",
    UPSTREAM_TIMEOUT: "The upstream data provider timed out.",
    UPSTREAM_ERROR: "The upstream data provider returned an error.",
    INTERNAL_ERROR: "An unexpected server error occurred.",
  },
  "zh-CN": {
    INVALID_REQUEST: "请求参数无效。",
    INVALID_SYMBOL: "代码格式不符合所选数据源的要求。",
    INVALID_DATE_RANGE: "日期范围无效或超过五年。",
    SOURCE_NOT_CONFIGURED: "服务器尚未配置此数据源。",
    NOT_FOUND: "未找到该代码与日期范围对应的行情数据。",
    ROUTE_NOT_FOUND: "请求的 API 路由不存在。",
    METHOD_NOT_ALLOWED: "该路由不支持所请求的 HTTP 方法。",
    RATE_LIMITED: "已超过公开接口限流，请稍后重试。",
    QUOTA_EXCEEDED: "项目免费额度保护已暂停供应商请求，请在提示的时间后重试。",
    QUOTA_UNAVAILABLE: "项目额度保护暂不可用，已暂停供应商请求以保护额度。",
    UPSTREAM_RATE_LIMITED: "上游数据提供方正在限流。",
    UPSTREAM_TIMEOUT: "上游数据提供方响应超时。",
    UPSTREAM_ERROR: "上游数据提供方返回错误。",
    INTERNAL_ERROR: "服务器发生意外错误。",
  },
};

export const disclaimer: Record<Locale, string> = {
  en: "Market data may be delayed or incomplete. This service does not provide investment advice.",
  "zh-CN": "行情数据可能延迟或不完整；本服务不构成投资建议。",
};

export function errorMessage(locale: Locale, code: ErrorCode): string {
  return messages[locale][code];
}

export function resolveLocale(value?: string | null, acceptLanguage?: string | null): Locale {
  const requested = value?.toLowerCase();
  if (requested === "zh-cn" || requested === "zh") return "zh-CN";
  if (requested === "en") return "en";
  return acceptLanguage?.toLowerCase().includes("zh") ? "zh-CN" : "en";
}

export function warningText(locale: Locale, key: "yahoo" | "raw" | "tiingo"): string {
  const dictionary = {
    en: {
      yahoo: "Yahoo Chart is an unofficial endpoint and may change without notice. Its prices may already reflect stock splits.",
      raw: "Daily OHLCV uses provider-reported values with no additional adjustment by this service. The API label raw does not guarantee exchange-original prices.",
      tiingo: "Data provided by Tiingo. Please review Tiingo attribution and usage terms.",
    },
    "zh-CN": {
      yahoo: "Yahoo Chart 为非官方接口，可能随时变更且不保证稳定；其价格可能已作拆股调整。",
      raw: "日线 OHLCV 保留供应商返回值，本服务不再复权；API 的 raw 标记不保证是交易所原始成交价格。",
      tiingo: "数据由 Tiingo 提供，请遵循其署名与使用条款。",
    },
  } satisfies Record<Locale, Record<string, string>>;
  return dictionary[locale][key];
}
