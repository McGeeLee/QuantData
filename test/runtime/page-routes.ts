/** Production-build routing over real local HTTP/workerd. Run npm run build first. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type BuiltConfig = {
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  assets: { directory: string; binding: string; not_found_handling?: string; run_worker_first?: boolean | string[] };
  version_metadata?: { binding: string };
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  migrations?: unknown[];
  ratelimits?: unknown[];
  vars?: { APP_VERSION?: string };
};
type LocalResponse = { status: number; headers: IncomingHttpHeaders; body: string };

const root = fileURLToPath(new URL("../../", import.meta.url));
const buildConfigPath = join(root, "dist/quantdata/wrangler.json");
const built = JSON.parse(await readFile(buildConfigPath, "utf8")) as BuiltConfig;
assert.equal(typeof built.main, "string", "Build must contain a Worker entry point");
assert.equal(typeof built.assets.directory, "string", "Build must contain a static assets directory");
const temporary = await mkdtemp(join(tmpdir(), "quant-data-page-routes-"));
let child: ChildProcess | undefined;
let logs = "";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((fulfill, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", fulfill);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((fulfill, reject) => server.close((error) => error ? reject(error) : fulfill()));
  return address.port;
}

function getLocal(port: number, path: string, navigate = false): Promise<LocalResponse> {
  return new Promise((fulfill, reject) => {
    const req = request({
      hostname: "127.0.0.1", port, path, method: "GET", agent: false,
      headers: navigate ? { accept: "text/html", "sec-fetch-mode": "navigate" } : { accept: "*/*" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) req.destroy(new Error("Unexpectedly large local response"));
      });
      response.on("error", reject);
      response.on("end", () => fulfill({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("Local page request timed out")));
    req.end();
  });
}

async function stopChild(processToStop: ChildProcess): Promise<void> {
  if (!processToStop.pid || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  const kill = (signal: NodeJS.Signals) => {
    if (!processToStop.pid) return;
    try {
      if (process.platform === "win32") processToStop.kill(signal);
      else process.kill(-processToStop.pid, signal);
    } catch { /* This test's process group has already exited. */ }
  };
  const stopped = new Promise<void>((fulfill) => processToStop.once("exit", () => fulfill()));
  kill("SIGTERM");
  const force = setTimeout(() => kill("SIGKILL"), 3_000);
  try { await stopped; } finally { clearTimeout(force); }
}

function jsonBody(response: LocalResponse): Record<string, unknown> {
  assert.match(response.headers["content-type"] ?? "", /application\/json/i);
  const body: unknown = JSON.parse(response.body);
  assert.ok(body && typeof body === "object" && !Array.isArray(body));
  return body as Record<string, unknown>;
}

try {
  const port = await unusedPort();
  const entry = join(temporary, "entry.mjs");
  const workerPath = JSON.stringify(resolve(dirname(buildConfigPath), built.main));
  // Import the final production bundle, including its DO export. Only outbound
  // global fetch is blocked; the real ASSETS binding still serves built files.
  await writeFile(entry, `import worker from ${workerPath};\nexport * from ${workerPath};\nglobalThis.fetch = async () => { throw new Error("External fetch blocked in local page routing regression"); };\nexport default worker;\n`);
  const config = join(temporary, "wrangler.json");
  await writeFile(config, JSON.stringify({
    name: "quant-data-page-routes-regression", main: entry,
    compatibility_date: built.compatibility_date, compatibility_flags: built.compatibility_flags,
    assets: { ...built.assets, directory: resolve(dirname(buildConfigPath), built.assets.directory) },
    version_metadata: built.version_metadata, durable_objects: built.durable_objects,
    migrations: built.migrations, ratelimits: built.ratelimits,
    vars: { APP_VERSION: built.vars?.APP_VERSION ?? "test", PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, TUSHARE_TOKEN: "", TIINGO_KEY: "" },
  }));
  let spawnError: Error | undefined;
  child = spawn(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", join(temporary, "state")], {
    cwd: temporary, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(temporary, "wrangler.log"), CI: "true" },
  });
  child.once("error", (error) => { spawnError = error; });
  const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-8_000); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let ready = false;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Local page Worker exited: ${logs}`);
    try { ready = (await getLocal(port, "/healthz")).status === 200; } catch { /* Wait only for this test's runtime. */ }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, `Local page Worker did not become ready: ${logs}`);

  let shell: string | undefined;
  for (const path of ["/", "/about", "/docs/en", "/docs/zh-CN"]) {
    for (const visit of ["direct navigation", "refresh"]) {
      const response = await getLocal(port, path, true);
      assert.equal(response.status, 200, `${path} ${visit}: ${response.body}`);
      assert.match(response.headers["content-type"] ?? "", /text\/html/i);
      assert.match(response.body, /<div[^>]+id=["']root["']/);
      shell ??= response.body;
      assert.equal(response.body, shell, `${path} must load the same production SPA entry`);
    }
    console.log(`PASS ${path}: production SPA HTML on direct navigation and refresh`);
  }
  const script = shell?.match(/<script[^>]+src=["']([^"']+)["']/)?.[1];
  assert.ok(typeof script === "string" && script.startsWith("/assets/"), "SPA HTML must reference its built JavaScript asset");
  const asset = await getLocal(port, script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"] ?? "", /javascript/i);
  assert.doesNotMatch(asset.body, /^\s*<!doctype html/i);
  console.log("PASS production JavaScript asset resolves through the real ASSETS binding");

  // Navigation headers deliberately prove that API priority wins over SPA fallback.
  for (const path of ["/api/v1", "/healthz", "/api/v1/sources"]) {
    const response = await getLocal(port, path, true);
    assert.equal(response.status, 200, `${path}: ${response.body}`);
    const body = jsonBody(response);
    if (path === "/api/v1") assert.ok(Array.isArray(body.endpoints));
    if (path === "/healthz") assert.equal(body.status, "ok");
    if (path === "/api/v1/sources") {
      assert.ok(Array.isArray(body.sources));
      for (const id of ["tushare", "tiingo"]) {
        const source: unknown = body.sources.find((value: unknown) => value && typeof value === "object" && "id" in value && value.id === id);
        assert.ok(source && typeof source === "object" && "configured" in source);
        assert.equal(source.configured, false, "This regression must use empty provider credentials");
      }
    }
    console.log(`PASS ${path}: JSON remains JSON even with browser navigation headers`);
  }
  const missing = await getLocal(port, "/api/v1/page-route-regression-missing", true);
  assert.equal(missing.status, 404);
  const error = jsonBody(missing).error;
  assert.ok(error && typeof error === "object" && "code" in error);
  assert.equal(error.code, "ROUTE_NOT_FOUND");
  console.log("PASS unknown API route: JSON 404, never the SPA shell");
} finally {
  if (child) await stopChild(child);
  await rm(temporary, { recursive: true, force: true });
}
