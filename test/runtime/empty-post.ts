/** Real HTTP/workerd regression. No credentials, external hosts, or live data. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request, type OutgoingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "quant-data-empty-post-"));
let child: ChildProcess | undefined;
let logs = "";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function localRequest(port: number, method: "GET" | "POST", path: string, headers: OutgoingHttpHeaders = {}, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path, headers, agent: false }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > 65_536) req.destroy(new Error("Unexpectedly large local response"));
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.setTimeout(3_000, () => req.destroy(new Error("Local HTTP request timed out")));
    req.end(body);
  });
}

async function stopChild(processToStop: ChildProcess): Promise<void> {
  if (processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  const kill = (signal: NodeJS.Signals) => {
    if (!processToStop.pid) return;
    try {
      // The isolated subprocess group contains only this test's Wrangler/workerd.
      if (process.platform === "win32") processToStop.kill(signal);
      else process.kill(-processToStop.pid, signal);
    } catch { /* Already exited. */ }
  };
  const stopped = new Promise<void>((resolve) => processToStop.once("exit", () => resolve()));
  kill("SIGTERM");
  const force = setTimeout(() => kill("SIGKILL"), 3_000);
  try { await stopped; } finally { clearTimeout(force); }
}

try {
  const port = await unusedPort();
  const entry = join(temporary, "entry.mjs");
  // Fail closed even if a future regression accidentally tries to call a provider.
  await writeFile(entry, `import worker from ${JSON.stringify(join(root, "worker/index.ts"))};\nglobalThis.fetch = async () => { throw new Error("External fetch blocked in local regression"); };\nexport default worker;\n`);
  const config = join(temporary, "wrangler.json");
  await writeFile(config, JSON.stringify({
    name: "quant-data-empty-post-regression", main: entry,
    compatibility_date: "2026-08-08", compatibility_flags: ["nodejs_compat"],
    version_metadata: { binding: "VERSION_METADATA" },
    ratelimits: [
      { name: "MARKET_RATE_LIMIT", namespace_id: "1222215593", simple: { limit: 60, period: 60 } },
      { name: "SOURCE_CHECK_RATE_LIMIT", namespace_id: "1222215594", simple: { limit: 1, period: 60 } },
    ],
    vars: { APP_VERSION: "3.1.0", PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, TUSHARE_TOKEN: "", TIINGO_KEY: "" },
  }));
  child = spawn(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", join(temporary, "state")], {
    cwd: temporary, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(temporary, "wrangler.log"), CI: "true" },
  });
  const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-8_000); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let ready = false;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (child.exitCode !== null) throw new Error(`Local Worker exited: ${logs}`);
    try { ready = (await localRequest(port, "GET", "/healthz")).status === 200; } catch { /* Wait for local startup. */ }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, `Local Worker did not become ready: ${logs}`);

  const path = "/api/v1/sources/tushare/check";
  for (const [name, headers] of [
    ["empty POST", {}],
    ["Content-Length: 0", { "content-length": "0" }],
    ["empty chunked POST", { "transfer-encoding": "chunked" }],
  ] as const) {
    const response = await localRequest(port, "POST", path, headers);
    assert.equal(response.status, 200, `${name}: ${response.body}`);
    const body: unknown = JSON.parse(response.body);
    assert.ok(body && typeof body === "object" && "status" in body);
    assert.equal(body.status, "not_configured");
    console.log(`PASS ${name}: HTTP 200 / not_configured (real local workerd)`);
  }
  for (const body of ["{}", " "]) {
    const response = await localRequest(port, "POST", path, { "content-type": "application/json" }, body);
    assert.equal(response.status, 400, response.body);
    assert.match(response.body, /"code":"INVALID_REQUEST"/);
    console.log(`PASS nonempty ${JSON.stringify(body)}: HTTP 400 / INVALID_REQUEST`);
  }
} finally {
  if (child) await stopChild(child);
  await rm(temporary, { recursive: true, force: true });
}
