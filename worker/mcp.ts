import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { createApiApp } from "./api";
import { docs } from "./docs-content";
import {
  DataSourceSchema,
  LocaleSchema,
  MarketDataResponseSchema,
  MarketSnapshotSchema,
  SourcesResponseSchema,
  type Locale,
} from "./domain/types";
import type { RuntimeEnv } from "./env";
import { retryAfterSeconds, toAppError } from "./lib/app-error";
import { errorMessage } from "./lib/i18n";
import { normalizeMarketQuery } from "./lib/query";
import { enforceRateLimit, getMarketData, getMarketSnapshot, listSources } from "./services/market-service";

const baseInput = z.object({
  source: DataSourceSchema.describe("Provider to query: yahoo (broad global/crypto, unofficial), tushare (China A-shares), or tiingo (US equities)"),
  symbol: z.string().trim().min(1).max(40).describe("Provider-native symbol: Yahoo AAPL/BTC-USD/600519.SS; Tushare 600519.SH; Tiingo AAPL"),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Inclusive start date, YYYY-MM-DD"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Inclusive end date, YYYY-MM-DD"),
  lang: LocaleSchema.default("en").describe("Language for messages and warnings"),
});

function queryFromInput(input: z.infer<typeof baseInput>) {
  return normalizeMarketQuery(input);
}

function retryHint(locale: Locale, retryable: boolean): string {
  if (!retryable) return locale === "zh-CN" ? "请修正参数、代码格式或数据源配置后重试。" : "Correct the parameters, symbol format, or source configuration before retrying.";
  return locale === "zh-CN" ? "请等待 Retry-After 指定的秒数后重试，或改用其他已配置数据源。" : "Retry after the indicated delay, or select another configured source.";
}

function toolError(error: unknown, locale: Locale, requestId: string) {
  const appError = toAppError(error);
  const retryable = ["RATE_LIMITED", "QUOTA_EXCEEDED", "QUOTA_UNAVAILABLE", "UPSTREAM_RATE_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_ERROR"].includes(appError.code);
  const retryAfter = retryAfterSeconds(appError);
  const output = {
    error: {
      code: appError.code,
      message: errorMessage(locale, appError.code),
      ...(appError.details === undefined ? {} : { details: appError.details }),
      retryable,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      hint: appError.code === "QUOTA_EXCEEDED" || appError.code === "QUOTA_UNAVAILABLE"
        ? (locale === "zh-CN" ? "项目额度保护已暂停请求；请遵循等待时间，不要立即重复调用。" : "Project budget protection paused this request. Honor the waiting period; do not retry immediately.")
        : retryHint(locale, retryable),
      requestId,
    },
  };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
  };
}

function resultText(era: "legacy" | "modern", summary: string, output: object): string {
  return era === "legacy" ? JSON.stringify(output) : summary;
}

function createServer(
  env: RuntimeEnv,
  request: Request,
  executionCtx: ExecutionContext,
  era: "legacy" | "modern",
  requestId: string,
) {
  const server = new McpServer({
    name: "quant-data",
    version: env.APP_VERSION,
  }, {
    instructions: "Use list_data_sources before selecting a provider; configured means credentials are present, not that an upstream was probed. Results are ascending provider-native daily OHLCV, not real-time quotes. adjustment=raw means no additional service adjustment; Yahoo OHLC may already reflect splits and adjclose is not used. Inspect latestBarDate, fetchedAt, and cache separately. Preserve warnings and attribution in downstream answers. Treat null values as unavailable, not zero. Never present results as investment advice.",
    cacheHints: {
      "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
      "resources/list": { ttlMs: 3_600_000, cacheScope: "public" },
      "resources/read": { ttlMs: 3_600_000, cacheScope: "public" },
      "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
    },
  });

  server.registerTool("list_data_sources", {
    title: "List data sources",
    description: "Call this first. Lists Yahoo, Tushare, and Tiingo configuration without revealing credentials, plus supported markets, exact symbol examples, stability warnings, and attribution requirements. Configured is not a connectivity check; no network market-data request is made.",
    inputSchema: z.object({ lang: LocaleSchema.default("en") }),
    outputSchema: SourcesResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ lang }) => {
    const output = listSources(env, lang);
    const configured = output.sources.filter((source) => source.configured).map((source) => source.id).join(", ");
    const summary = `${output.sources.length} sources; configured: ${configured || "none"}. Inspect structuredContent for symbol examples, warnings, and attribution.`;
    return { content: [{ type: "text", text: resultText(era, summary, output) }], structuredContent: output };
  });

  server.registerTool("get_market_data", {
    title: "Get market data",
    description: "Returns ascending daily, provider-native OHLCV bars, not real-time quotes. Dates are inclusive; omitted dates mean the most recent calendar month. The tool returns the most recent 120 bars by default and at most 500. Check meta.latestBarDate, fetchedAt, cache, truncated, warnings, volumeUnit, and attribution before using the series.",
    inputSchema: baseInput.extend({ limit: z.number().int().min(1).max(500).default(120).describe("Maximum most-recent bars to return after sorting; 1-500") }),
    outputSchema: MarketDataResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const query = queryFromInput(input);
      await enforceRateLimit(env, request, query.source);
      const output = await getMarketData(env, query, input.lang, { maxBars: input.limit, executionCtx });
      const summary = `${output.meta.source}:${output.meta.symbol} ${output.meta.count} daily bars (${output.bars[0]?.date ?? "n/a"}..${output.bars.at(-1)?.date ?? "n/a"}), truncated=${output.meta.truncated}`;
      const attribution = output.meta.attribution ? ` Attribution: ${output.meta.attribution}` : "";
      return { content: [{ type: "text", text: resultText(era, `${summary}.${attribution} Preserve ${output.meta.warnings.length} warning(s).`, output) }], structuredContent: output };
    } catch (error) {
      return toolError(error, input.lang, requestId);
    }
  });

  server.registerTool("get_market_snapshot", {
    title: "Get market snapshot",
    description: "Returns the latest available daily close, previous returned trading-day close, absolute change, percentage change, and volume. The service applies no further price adjustments; upstream prices may already reflect splits. previousClose, change, and changePercent are null when the range contains only one bar.",
    inputSchema: baseInput,
    outputSchema: MarketSnapshotSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const query = queryFromInput(input);
      await enforceRateLimit(env, request, query.source);
      const output = await getMarketSnapshot(env, query, input.lang, { executionCtx });
      const summary = `${output.meta.source}:${output.meta.symbol} ${output.snapshot.date} close=${output.snapshot.close} changePercent=${output.snapshot.changePercent ?? "n/a"}`;
      const attribution = output.meta.attribution ? ` Attribution: ${output.meta.attribution}` : "";
      return { content: [{ type: "text", text: resultText(era, `${summary}.${attribution} Preserve ${output.meta.warnings.length} warning(s).`, output) }], structuredContent: output };
    } catch (error) {
      return toolError(error, input.lang, requestId);
    }
  });

  server.registerResource("quant-data-docs-en", "quant-data://docs/en", {
    title: "Quant Data documentation (English)",
    description: "REST API and MCP usage, constraints, warnings, and examples.",
    mimeType: "text/markdown",
    size: new TextEncoder().encode(docs.en).byteLength,
    annotations: { audience: ["user", "assistant"], priority: 1, lastModified: env.VERSION_METADATA.timestamp },
    cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: docs.en }] }));

  server.registerResource("quant-data-docs-zh-cn", "quant-data://docs/zh-CN", {
    title: "Quant Data 文档（中文）",
    description: "REST API 与 MCP 用法、限制、风险和示例。",
    mimeType: "text/markdown",
    size: new TextEncoder().encode(docs["zh-CN"]).byteLength,
    annotations: { audience: ["user", "assistant"], priority: 1, lastModified: env.VERSION_METADATA.timestamp },
    cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: docs["zh-CN"] }] }));

  server.registerResource("quant-data-openapi", "quant-data://api/openapi", {
    title: "Quant Data OpenAPI 3.1 contract",
    description: "Machine-readable REST API contract with stable operation IDs, parameters, response schemas, and errors.",
    mimeType: "application/json",
    annotations: { audience: ["assistant"], priority: 0.9, lastModified: env.VERSION_METADATA.timestamp },
    cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
  }, async (uri) => {
    const response = await createApiApp(executionCtx).fetch(new Request(new URL("/openapi.json", request.url)), env, executionCtx);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: await response.text() }] };
  });

  return server;
}

export async function handleMcp(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  // This is deployment configuration, never an allowlist derived from the
  // untrusted request Host/Origin. Local development remains explicitly allowed.
  let publicHostname: string;
  try {
    const publicUrl = new URL(env.PUBLIC_ORIGIN);
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password
      || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
      throw new Error("Invalid public origin");
    }
    publicHostname = publicUrl.hostname;
  } catch {
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "MCP deployment configuration is invalid.", requestId } }, {
      status: 500,
      headers: { "x-request-id": requestId, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }
  const handler = createMcpHandler(({ era }) => createServer(env, request, ctx, era, requestId), {
    route: "/mcp",
    legacy: "stateless",
    responseMode: "auto",
    corsOptions: { origin: "*", methods: "POST, OPTIONS", headers: "content-type, mcp-protocol-version, mcp-session-id" },
    allowedHostnames: [publicHostname, "localhost", "127.0.0.1", "[::1]"],
    allowedOriginHostnames: [
      publicHostname,
      "localhost",
      "127.0.0.1",
      "[::1]",
      "inspector.modelcontextprotocol.io",
    ],
    onerror(error) {
      console.error(JSON.stringify({ event: "mcp_error", requestId, name: error.name }));
    },
  });
  const response = await handler(request, env, ctx);
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
