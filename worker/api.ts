import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  ApiErrorSchema,
  DataSourceSchema,
  LocaleSchema,
  MarketDataResponseSchema,
  MarketSnapshotSchema,
  SourcesResponseSchema,
  type Locale,
} from "./domain/types";
import type { RuntimeEnv } from "./env";
import { ConnectionCheckSchema } from "./domain/connectivity";
import { AppError, retryAfterSeconds, toAppError } from "./lib/app-error";
import { errorMessage, resolveLocale } from "./lib/i18n";
import { normalizeMarketQuery } from "./lib/query";
import { assertEmptyRequestBody } from "./lib/request-body";
import { enforceRateLimit, getMarketData, getMarketSnapshot, listSources } from "./services/market-service";
import { checkSourceConnection } from "./services/connectivity-service";

type Variables = { requestId: string; locale: Locale };
type AppBindings = { Bindings: RuntimeEnv; Variables: Variables };

const API_VERSION = "v1";
const CONNECTION_CHECK_PATH = /^\/api\/v1\/sources\/[^/]+\/check$/;

const querySchema = z.object({
  source: DataSourceSchema.openapi({ example: "yahoo" }),
  symbol: z.string().trim().min(1).max(40).openapi({ example: "AAPL" }),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ example: "2025-01-01", description: "Inclusive start date. Defaults to the same day one calendar month before end, clamped to that month's last day if needed." }),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ example: "2025-12-31", description: "Inclusive end date. Defaults to today in UTC." }),
  lang: LocaleSchema.optional().openapi({ example: "en" }),
});

const errorResponses = {
  400: { description: "Invalid request", content: { "application/json": { schema: ApiErrorSchema } } },
  404: { description: "No data found", content: { "application/json": { schema: ApiErrorSchema } } },
  405: { description: "Method not allowed", content: { "application/json": { schema: ApiErrorSchema } } },
  429: { description: "Rate limited or project free-tier budget reached", content: { "application/json": { schema: ApiErrorSchema } } },
  502: { description: "Upstream failure", content: { "application/json": { schema: ApiErrorSchema } } },
  503: { description: "Source or budget protection unavailable", content: { "application/json": { schema: ApiErrorSchema } } },
  504: { description: "Upstream timeout", content: { "application/json": { schema: ApiErrorSchema } } },
  500: { description: "Internal error", content: { "application/json": { schema: ApiErrorSchema } } },
} as const;

const HealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("quant-data"),
  version: z.string(),
  deployment: z.object({ id: z.string(), tag: z.string(), timestamp: z.string().datetime() }),
});

const ApiIndexSchema = z.object({
  service: z.literal("quant-data"),
  apiVersion: z.literal("v1"),
  authentication: z.literal("none"),
  links: z.object({
    openapi: z.string().url(),
    documentation: z.object({ en: z.string().url(), "zh-CN": z.string().url() }),
    mcp: z.string().url(),
  }),
  endpoints: z.array(z.object({ method: z.enum(["GET", "POST"]), path: z.string(), operationId: z.string() })),
  constraints: z.object({ interval: z.literal("1d"), adjustment: z.literal("raw"), maximumYears: z.literal(5), maximumBars: z.literal(2000) }),
  disclaimer: z.string(),
});

function errorResponse(c: Context<AppBindings>, error: AppError) {
  const body = {
    error: {
      code: error.code,
      message: errorMessage(c.get("locale"), error.code),
      ...(error.details === undefined ? {} : { details: error.details }),
      requestId: c.get("requestId"),
    },
  };
  const retryAfter = retryAfterSeconds(error);
  const headers = {
    "cache-control": "no-store",
    ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }),
  };
  return c.json(body, error.status, headers);
}

export function createApiApp(executionCtx?: ExecutionContext) {
  const app = new OpenAPIHono<AppBindings>({
    defaultHook: (result, c) => result.success
      ? undefined
      : errorResponse(c, new AppError("INVALID_REQUEST", 400, result.error.flatten())),
  });

  app.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    referrerPolicy: "no-referrer",
  }));
  const publicCors = cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    exposeHeaders: ["X-Request-Id", "X-API-Version", "Retry-After"],
    maxAge: 86400,
  });
  const connectionCheckCors = cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    exposeHeaders: ["X-Request-Id", "X-API-Version", "Retry-After"],
    maxAge: 86400,
  });
  const apiCors: MiddlewareHandler<AppBindings> = (c, next) => CONNECTION_CHECK_PATH.test(c.req.path)
    ? connectionCheckCors(c, next)
    : publicCors(c, next);
  app.use("/api/*", apiCors);
  app.use("/healthz", publicCors);
  app.use("/openapi.json", publicCors);
  app.use("*", async (c, next) => {
    const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    c.set("locale", resolveLocale(c.req.query("lang"), c.req.header("accept-language")));
    c.header("x-request-id", requestId);
    c.header("x-api-version", API_VERSION);
    c.header("vary", "Accept-Language");
    await next();
  });

  app.openapi(createRoute({
    method: "get",
    path: "/healthz",
    operationId: "getHealth",
    tags: ["Service"],
    summary: "Get service and deployment health",
    description: "Returns process-level health without probing upstream providers or revealing secret configuration.",
    responses: { 200: { description: "Service is accepting requests", content: { "application/json": { schema: HealthSchema } } } },
  }), (c) => {
    c.header("cache-control", "no-store");
    return c.json({
      status: "ok" as const,
      service: "quant-data" as const,
      version: c.env.APP_VERSION,
      deployment: {
        id: c.env.VERSION_METADATA.id,
        tag: c.env.VERSION_METADATA.tag,
        timestamp: c.env.VERSION_METADATA.timestamp,
      },
    }, 200);
  });

  app.openapi(createRoute({
    method: "get",
    path: "/api/v1",
    operationId: "discoverApi",
    tags: ["Service"],
    summary: "Discover the public API",
    description: "Stable entry point for clients to discover contracts, documentation, MCP transport, and v1 constraints.",
    request: { query: z.object({ lang: LocaleSchema.optional() }) },
    responses: { 200: { description: "API discovery document", content: { "application/json": { schema: ApiIndexSchema } } } },
  }), (c) => {
    c.header("cache-control", "public, max-age=3600");
    const origin = new URL(c.req.url).origin;
    return c.json({
      service: "quant-data" as const,
      apiVersion: "v1" as const,
      authentication: "none" as const,
      links: {
        openapi: `${origin}/openapi.json`,
        documentation: { en: `${origin}/docs/en`, "zh-CN": `${origin}/docs/zh-CN` },
        mcp: `${origin}/mcp`,
      },
      endpoints: [
        { method: "GET" as const, path: "/api/v1/sources", operationId: "listDataSources" },
        { method: "GET" as const, path: "/api/v1/market-data", operationId: "getMarketData" },
        { method: "GET" as const, path: "/api/v1/snapshot", operationId: "getMarketSnapshot" },
        { method: "POST" as const, path: "/api/v1/sources/{source}/check", operationId: "checkSourceConnection" },
      ],
      constraints: { interval: "1d" as const, adjustment: "raw" as const, maximumYears: 5 as const, maximumBars: 2000 as const },
      disclaimer: c.get("locale") === "zh-CN"
        ? "行情数据可能延迟或不完整；本服务不构成投资建议。"
        : "Market data may be delayed or incomplete. This service does not provide investment advice.",
    }, 200);
  });

  app.openapi(createRoute({
    method: "get",
    path: "/api/v1/sources",
    operationId: "listDataSources",
    tags: ["Market data"],
    summary: "List market data sources and configuration status",
    description: "Reports source configuration without exposing credentials, contacting providers, or validating keys. Includes provider-native symbol examples, stability warnings, and attribution. Use the explicit POST check endpoint for a connectivity diagnosis.",
    request: { query: z.object({ lang: LocaleSchema.optional() }) },
    responses: { 200: { description: "Source status", content: { "application/json": { schema: SourcesResponseSchema } } } },
  }), (c) => {
    c.header("cache-control", "public, max-age=60");
    return c.json(listSources(c.env, c.get("locale")), 200);
  });

  app.openapi(createRoute({
    method: "post",
    path: "/api/v1/sources/{source}/check",
    operationId: "checkSourceConnection",
    tags: ["Service"],
    summary: "Manually check a data source with a fixed sample",
    description: "No request body. Checks an allowlisted ticker over the recent calendar month with one upstream attempt; returns diagnostic metadata without prices, credentials, or raw provider messages. Separate diagnostic results can be reused for five minutes or a longer upstream retry delay. Fresh probes have an approximate per-location limit of one per source per minute; neither this limit nor cache contents are globally coordinated. Ordinary source listing and health requests never trigger probes.",
    request: {
      params: z.object({ source: DataSourceSchema }),
      query: z.object({ lang: LocaleSchema.optional() }).strict(),
    },
    responses: {
      200: { description: "Source check result, including sanitized provider failures", content: { "application/json": { schema: ConnectionCheckSchema } } },
      ...errorResponses,
    },
  }), async (c) => {
    await assertEmptyRequestBody(c.req.raw);
    const source = DataSourceSchema.parse(c.req.param("source"));
    const output = await checkSourceConnection(c.env, source, { executionCtx, requestId: c.get("requestId") });
    c.header("cache-control", "no-store");
    return c.json(output, 200);
  });

  app.openapi(createRoute({
    method: "get",
    path: "/api/v1/market-data",
    operationId: "getMarketData",
    tags: ["Market data"],
    summary: "Get normalized, daily, provider-native OHLCV bars",
    description: "Returns provider-reported daily bars in ascending trading-date order without further price adjustment. The legacy raw label means no additional adjustment by this service; Yahoo prices may already reflect stock splits. Dates are inclusive. End defaults to today in UTC; an omitted start defaults to the same day one calendar month before end, clamped to the preceding month's last day if needed. Ranges are limited to five years and 2,000 bars.",
    request: { query: querySchema },
    responses: {
      200: { description: "Market data", content: { "application/json": { schema: MarketDataResponseSchema } } },
      ...errorResponses,
    },
  }), async (c) => {
    const query = normalizeMarketQuery(querySchema.parse(c.req.query()));
    await enforceRateLimit(c.env, c.req.raw, query.source);
    const output = await getMarketData(c.env, query, c.get("locale"), { executionCtx });
    c.header("cache-control", "public, max-age=60");
    return c.json(output, 200);
  });

  app.openapi(createRoute({
    method: "get",
    path: "/api/v1/snapshot",
    operationId: "getMarketSnapshot",
    tags: ["Market data"],
    summary: "Get the latest bar and previous-close change metrics",
    description: "Returns the last available daily close and its change from the preceding returned trading day. A null previousClose means only one bar was available.",
    request: { query: querySchema },
    responses: {
      200: { description: "Market snapshot", content: { "application/json": { schema: MarketSnapshotSchema } } },
      ...errorResponses,
    },
  }), async (c) => {
    const query = normalizeMarketQuery(querySchema.parse(c.req.query()));
    await enforceRateLimit(c.env, c.req.raw, query.source);
    const output = await getMarketSnapshot(c.env, query, c.get("locale"), { executionCtx });
    c.header("cache-control", "public, max-age=60");
    return c.json(output, 200);
  });

  app.doc31("/openapi.json", (c) => ({
    openapi: "3.1.0",
    info: {
      title: "Quant Data API",
      version: "3.1.0",
      description: "Public, read-only v1 API for normalized daily provider-native OHLCV data without further adjustment. The raw label is retained for compatibility; Yahoo prices may already reflect stock splits. Messages can be localized; field names and error codes remain stable. Data may be delayed or incomplete. Not investment advice.",
      contact: { name: "Quant Data", url: "https://github.com/McGeeLee/Quant-Data" },
    },
    servers: [{ url: new URL(c.req.url).origin, description: "Current deployment" }],
    externalDocs: { description: "English API and MCP documentation", url: `${new URL(c.req.url).origin}/docs/en` },
    security: [],
    tags: [
      { name: "Service", description: "Health and API discovery" },
      { name: "Market data", description: "Read-only normalized market data" },
    ],
  }));

  for (const path of ["/healthz", "/api/v1", "/api/v1/sources", "/api/v1/market-data", "/api/v1/snapshot", "/openapi.json"]) {
    app.all(path, (c) => {
      c.header("allow", "GET, OPTIONS");
      return errorResponse(c, new AppError("METHOD_NOT_ALLOWED", 405));
    });
  }
  app.all("/api/v1/sources/:source/check", (c) => {
    c.header("allow", "POST, OPTIONS");
    return errorResponse(c, new AppError("METHOD_NOT_ALLOWED", 405));
  });

  app.notFound((c) => errorResponse(c, new AppError("ROUTE_NOT_FOUND", 404)));
  app.onError((error, c) => {
    const appError = toAppError(error);
    if (appError.status >= 500) {
      console.error(JSON.stringify({
        event: "api_error",
        requestId: c.get("requestId"),
        code: appError.code,
        status: appError.status,
        method: c.req.method,
        path: c.req.path,
      }));
    }
    return errorResponse(c, appError);
  });
  return app;
}
