/** Native workerd fetch regression against a loopback-only HTTP fixture. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "quant-data-provider-transport-"));
const localToken = randomUUID(); // Test-only authentication, unrelated to any provider account.
const observed: Array<{ path: string; method: string; body: string }> = [];
let child: ChildProcess | undefined;
let logs = "";

const fixture = createHttpServer((req, res) => {
  if (req.headers["x-fixture-token"] !== localToken) {
    res.writeHead(403).end();
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
    if (body.length > 1_024) req.destroy(new Error("Unexpected fixture request body"));
  });
  req.on("end", () => {
    const path = req.url ?? "/";
    const method = req.method ?? "GET";
    observed.push({ path, method, body });
    if (path === "/redirect-302" || path === "/redirect-307") {
      const status = path.endsWith("302") ? 302 : 307;
      res.writeHead(status, { location: `/target-${status}` }).end();
    } else if (path === "/forbidden") {
      res.writeHead(403, { "content-type": "application/json" }).end('{"error":"fixture denied"}');
    } else if (path === "/throttled") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end('{"error":"fixture rate limit"}');
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method, body }));
    }
  });
});

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

function localRequest(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, agent: false, headers: { "x-test-token": localToken } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 65_536) req.destroy(new Error("Unexpectedly large local response"));
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("Local transport test timed out")));
    req.end();
  });
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
}

async function runCase(port: number, name: string): Promise<Record<string, unknown>> {
  const response = await localRequest(port, `/run/${name}`);
  assert.equal(response.status, 200, response.body);
  const value: unknown = JSON.parse(response.body);
  assertRecord(value);
  return value;
}

async function stopChild(processToStop: ChildProcess): Promise<void> {
  if (!processToStop.pid || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") processToStop.kill(signal);
      else if (processToStop.pid) process.kill(-processToStop.pid, signal);
    } catch { /* Only this test's isolated subprocess group is targeted. */ }
  };
  const stopped = new Promise<void>((resolve) => processToStop.once("exit", () => resolve()));
  kill("SIGTERM");
  const force = setTimeout(() => kill("SIGKILL"), 3_000);
  try { await stopped; } finally { clearTimeout(force); }
}

try {
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  const fixtureAddress = fixture.address();
  assert.ok(fixtureAddress && typeof fixtureAddress !== "string");
  const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
  const port = await unusedPort();
  const entry = join(temporary, "entry.mjs");
  await writeFile(entry, `
import { createBudgetedFetch } from ${JSON.stringify(join(root, "worker/lib/budgeted-fetch.ts"))};
import { fetchUpstream } from ${JSON.stringify(join(root, "worker/lib/upstream-fetch.ts"))};
const cases = {
  get: { path: "/ok-get", method: "GET" },
  post: { path: "/ok-post", method: "POST", body: '{"sample":"local-fixture"}' },
  redirect302: { path: "/redirect-302", method: "GET" },
  redirect307: { path: "/redirect-307", method: "POST", body: '{"sample":"local-fixture"}' },
  forbidden: { path: "/forbidden", method: "GET" },
  throttled: { path: "/throttled", method: "GET" },
  denied: { path: "/denied-target", method: "GET", denied: true },
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== "127.0.0.1" || request.headers.get("x-test-token") !== env.TEST_TOKEN) return new Response(null, { status: 404 });
    if (url.pathname === "/healthz") return new Response("ready");
    const name = url.pathname.startsWith("/run/") ? url.pathname.slice(5) : "";
    if (!Object.hasOwn(cases, name)) return new Response(null, { status: 404 });
    const testCase = cases[name];
    // Targets are fixed loopback fixtures. No user-controlled upstream URL exists.
    const target = new URL(testCase.path, env.FIXTURE_ORIGIN);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") throw new Error("Nonlocal fixture target");
    let reserves = 0;
    let settles = 0;
    const budget = { getByName(source) {
      if (source !== "tiingo") throw new Error("Unexpected test source");
      return {
        async reserve() {
          reserves++;
          return testCase.denied ? { allowed: false, reason: "hour_requests", retryAfterSeconds: 60 }
            : { allowed: true, reservationId: "local-reservation-" + reserves };
        },
        async settle() { settles++; },
      };
    } };
    // Intentionally use the default native fetch; mocking it hid the regression.
    const budgeted = createBudgetedFetch({ PROVIDER_BUDGET: budget }, "tiingo", "AAPL");
    try {
      const response = await fetchUpstream(target, {
        method: testCase.method, body: testCase.body,
        headers: { "x-fixture-token": env.TEST_TOKEN, "content-type": "application/json" },
      }, budgeted);
      return Response.json({ ok: true, upstreamStatus: response.status, payload: await response.json(), reserves, settles });
    } catch (error) {
      return Response.json({ ok: false, code: error.code, reason: error.details?.reason, upstreamStatus: error.details?.upstreamStatus, reserves, settles });
    }
  }
};
`);
  const config = join(temporary, "wrangler.json");
  await writeFile(config, JSON.stringify({
    name: "quant-data-provider-transport-regression", main: entry,
    compatibility_date: "2026-08-08", compatibility_flags: ["nodejs_compat"],
    vars: { TEST_TOKEN: localToken, FIXTURE_ORIGIN: fixtureOrigin },
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
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Local transport Worker exited: ${logs}`);
    try { ready = (await localRequest(port, "/healthz")).status === 200; } catch { /* Local startup. */ }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, `Local transport Worker did not become ready: ${logs}`);

  for (const [name, path, method, sentBody] of [
    ["get", "/ok-get", "GET", ""],
    ["post", "/ok-post", "POST", '{"sample":"local-fixture"}'],
  ] as const) {
    const result = await runCase(port, name);
    const requests = observed.filter((item) => item.path === path);
    assert.equal(result.ok, true, `${method} native fetch failed: ${JSON.stringify(result)}; fixture requests=${requests.length}`);
    assert.equal(result.upstreamStatus, 200);
    assert.equal(result.reserves, 1);
    assert.equal(result.settles, 1);
    assert.deepEqual(requests, [{ path, method, body: sentBody }]);
    assert.deepEqual(result.payload, { method, body: sentBody });
    console.log(`PASS native workerd ${method} reaches loopback fixture exactly once and settles once`);
  }
  for (const [name, status] of [["redirect302", 302], ["redirect307", 307]] as const) {
    const result = await runCase(port, name);
    assert.equal(result.ok, false);
    assert.equal(result.code, "UPSTREAM_ERROR");
    assert.equal(result.upstreamStatus, status);
    assert.equal(result.reserves, 1);
    assert.equal(result.settles, 0);
    assert.equal(observed.filter((item) => item.path === `/redirect-${status}`).length, 1);
    assert.equal(observed.filter((item) => item.path === `/target-${status}`).length, 0, "Redirect destination must never be requested");
    console.log(`PASS native workerd ${status}: rejected as upstream error, redirect destination receives zero calls`);
  }
  for (const [name, path, status, code] of [
    ["forbidden", "/forbidden", 403, "UPSTREAM_ERROR"],
    ["throttled", "/throttled", 429, "UPSTREAM_RATE_LIMITED"],
  ] as const) {
    const result = await runCase(port, name);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.upstreamStatus, status);
    assert.equal(result.reserves, 1);
    assert.equal(result.settles, 0);
    assert.equal(observed.filter((item) => item.path === path).length, 1);
    console.log(`PASS native workerd ${status}: one upstream request, no automatic retry`);
  }
  const beforeDenied = observed.length;
  const denied = await runCase(port, "denied");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "QUOTA_EXCEEDED");
  assert.equal(denied.reserves, 1);
  assert.equal(denied.settles, 0);
  assert.equal(observed.length, beforeDenied);
  assert.equal(observed.filter((item) => item.path === "/denied-target").length, 0);
  console.log("PASS budget refusal: zero native upstream network calls");
} finally {
  try {
    if (child) await stopChild(child);
  } finally {
    fixture.closeAllConnections();
    if (fixture.listening) await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
}
