import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcp } from "../worker/mcp";
import worker from "../worker/index";
import type { RuntimeEnv } from "../worker/env";
import { testEnv, testExecutionContext, yahooPayload } from "./fixtures";

// Node tests exercise the default Worker entry; real DO behavior is covered in workerd.
vi.mock("../worker/durable-objects/provider-budget", () => ({ ProviderBudget: class {} }));

afterEach(() => vi.unstubAllGlobals());

function transportFetch(env: RuntimeEnv): FetchLike {
  return async (input, init) => {
    const incoming = input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(incoming.headers);
    headers.set("host", new URL(incoming.url).host);
    const request = new Request(incoming, { headers });
    return handleMcp(request, env, testExecutionContext);
  };
}

async function connect(mode: "auto" | "legacy", env = testEnv(), origin = env.PUBLIC_ORIGIN) {
  const client = new Client({ name: `quant-data-test-${mode}`, version: "1.0.0" }, {
    versionNegotiation: { mode },
  });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    fetch: transportFetch(env),
  });
  await client.connect(transport);
  return client;
}

describe("stateless MCP server", () => {
  it("accepts the configured deployment host and publishes that API origin", async () => {
    const origin = "https://data.example.com";
    const client = await connect("auto", testEnv({ PUBLIC_ORIGIN: origin }));
    try {
      expect((await client.listTools()).tools).toHaveLength(3);
      const openapi = await client.readResource({ uri: "quant-data://api/openapi" });
      const content = openapi.contents[0];
      expect(content && "text" in content ? JSON.parse(content.text) : {}).toMatchObject({
        servers: [{ url: origin }],
      });
    } finally {
      await client.close();
    }
  });

  it("keeps localhost development available with a configured public domain", async () => {
    const client = await connect("auto", testEnv({ PUBLIC_ORIGIN: "https://data.example.com" }), "http://127.0.0.1:5183");
    try {
      expect((await client.listTools()).tools).toHaveLength(3);
    } finally {
      await client.close();
    }
  });

  it("rejects an unconfigured Host and arbitrary browser Origins", async () => {
    const env = testEnv({ PUBLIC_ORIGIN: "https://data.example.com" });
    for (const headers of [
      { host: "attacker.example", origin: "https://data.example.com" },
      { host: "data.example.com", origin: "https://attacker.example" },
      { host: "data.example.com", origin: "null" },
    ]) {
      const response = await handleMcp(new Request("https://data.example.com/mcp", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }), env, testExecutionContext);
      expect(response.status).toBe(403);
    }
  });

  it("uses the current deployment origin in both LLM discovery documents", async () => {
    for (const path of ["/llms.txt", "/llms-full.txt"]) {
      const response = await worker.fetch(new Request(`https://data.example.com${path}`), testEnv(), testExecutionContext);
      const text = await response.text();
      expect(text).toContain("https://data.example.com/mcp");
      expect(text).toContain("https://data.example.com/openapi.json");
      expect(text).not.toContain("quant-data.mcgeelee.workers.dev");
    }
  });

  it("fails closed for invalid deployment origins without echoing configuration", async () => {
    for (const origin of ["", "http://data.example.com", "https://user:private-value@data.example.com", "https://data.example.com/path"]) {
      const response = await handleMcp(new Request("https://data.example.com/mcp"), testEnv({ PUBLIC_ORIGIN: origin }), testExecutionContext);
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).toContain("INTERNAL_ERROR");
      expect(body).not.toContain("private-value");
    }
  });

  it("discovers all tools and documentation resources with the modern protocol", async () => {
    const client = await connect("auto");
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["list_data_sources", "get_market_data", "get_market_snapshot"]);
      expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toEqual(["quant-data://docs/en", "quant-data://docs/zh-CN", "quant-data://api/openapi"]);
      const openapi = await client.readResource({ uri: "quant-data://api/openapi" });
      const firstContent = openapi.contents[0];
      const text = firstContent && "text" in firstContent ? firstContent.text : undefined;
      expect(typeof text === "string" ? JSON.parse(text) : {}).toMatchObject({ openapi: "3.1.0" });
    } finally {
      await client.close();
    }
  });

  it("supports an ordinary legacy stateless client", async () => {
    const client = await connect("legacy");
    try {
      const result = await client.callTool({ name: "list_data_sources", arguments: { lang: "zh-CN" } });
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as { sources: Array<{ id: string }> }).sources[0]?.id).toBe("yahoo");
      const first = result.content[0];
      expect(first?.type === "text" ? JSON.parse(first.text) : {}).toHaveProperty("sources");
    } finally {
      await client.close();
    }
  });

  it("returns concise text and validated structured market data", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(yahooPayload())));
    const client = await connect("auto");
    try {
      const result = await client.callTool({
        name: "get_market_data",
        arguments: { source: "yahoo", symbol: "AAPL", start: "2026-08-01", end: "2026-08-10", limit: 1, lang: "en" },
      });
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.structuredContent).toMatchObject({ meta: { count: 1, truncated: true }, bars: [{ close: 104 }] });
    } finally {
      await client.close();
    }
  });

  it("rejects invalid tool parameters at the protocol boundary", async () => {
    const client = await connect("auto");
    try {
      const result = await client.callTool({ name: "get_market_data", arguments: { source: "invalid", symbol: "AAPL" } });
      expect(result.isError).toBe(true);
      const first = result.content[0];
      expect(first?.type).toBe("text");
      expect(first?.type === "text" ? first.text : "").toContain("Input validation error");
    } finally {
      await client.close();
    }
  });

  it("returns model-actionable application errors", async () => {
    const client = await connect("auto");
    try {
      const result = await client.callTool({ name: "get_market_data", arguments: { source: "tushare", symbol: "AAPL", lang: "en" } });
      expect(result.isError).toBe(true);
      const first = result.content[0];
      const body = first?.type === "text" ? JSON.parse(first.text) as { error: Record<string, unknown> } : { error: {} };
      expect(body.error).toMatchObject({ code: "INVALID_SYMBOL", retryable: false });
      expect(body.error).toHaveProperty("hint");
      expect(body.error).toHaveProperty("requestId");
    } finally {
      await client.close();
    }
  });

  it("uses the same budget guard for MCP without probing the provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("caches", undefined);
    const client = await connect("auto", testEnv({ PROVIDER_BUDGET: { getByName: () => ({
      reserve: async () => ({ allowed: false as const, reason: "day_requests" as const, retryAfterSeconds: 180 }),
      settle: async () => undefined,
    }) } }));
    try {
      const result = await client.callTool({ name: "get_market_snapshot", arguments: { source: "yahoo", symbol: "AAPL", lang: "en" } });
      expect(result.isError).toBe(true);
      const first = result.content[0];
      const body = first?.type === "text" ? JSON.parse(first.text) as { error: Record<string, unknown> } : { error: {} };
      expect(body.error).toMatchObject({ code: "QUOTA_EXCEEDED", retryAfterSeconds: 180, retryable: true });
      expect(body.error.hint).toContain("do not retry immediately");
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
});
