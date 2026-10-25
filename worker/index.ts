import { createApiApp } from "./api";
import { llmsFullText, llmsText } from "./docs-content";
import type { RuntimeEnv } from "./env";
import { handleMcp } from "./mcp";

export { ProviderBudget } from "./durable-objects/provider-budget";

export default {
  async fetch(request: Request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return handleMcp(request, env, ctx);
    if (url.pathname === "/llms.txt" || url.pathname === "/llms-full.txt") {
      return new Response(url.pathname === "/llms.txt" ? llmsText(url.origin) : llmsFullText(url.origin), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (url.pathname === "/healthz" || url.pathname === "/openapi.json" || url.pathname.startsWith("/api/")) {
      return createApiApp(ctx).fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<RuntimeEnv>;
