/** Real local workerd + SQLite regression. No provider calls or production bindings. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type Source = "yahoo" | "tushare" | "tiingo";
type Reservation = { allowed: boolean; reservationId?: string; retryAfterSeconds?: number };
type HttpResult = { status: number; body: string };

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "quant-data-provider-budget-"));
const rpcToken = randomUUID(); // Local test isolation only; this is not an account credential.
const persistence = join(temporary, "state");
const config = join(temporary, "wrangler.json");
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

function localRequest(port: number, path: string, payload?: Record<string, unknown>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = request({
      hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", agent: false,
      headers: { "x-test-token": rpcToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    }, (response) => {
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
    req.setTimeout(5_000, () => req.destroy(new Error("Local budget RPC timed out")));
    req.end(body);
  });
}

async function reserve(port: number, source: Source, symbol: string): Promise<Reservation> {
  const response = await localRequest(port, `/reserve/${source}`, { symbol });
  assert.equal(response.status, 200, response.body);
  const value: unknown = JSON.parse(response.body);
  assert.ok(value && typeof value === "object" && "allowed" in value && typeof value.allowed === "boolean");
  const reservationId = "reservationId" in value ? value.reservationId : undefined;
  const retryAfterSeconds = "retryAfterSeconds" in value ? value.retryAfterSeconds : undefined;
  assert.ok(reservationId === undefined || typeof reservationId === "string");
  assert.ok(retryAfterSeconds === undefined || (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)));
  return { allowed: value.allowed, reservationId, retryAfterSeconds };
}

async function settle(port: number, reservationId: string, bytes: number): Promise<void> {
  const response = await localRequest(port, "/settle/tiingo", { reservationId, bytes });
  assert.equal(response.status, 200, response.body);
  assert.equal(response.body, '{"settled":true}');
}

async function byteTotal(port: number): Promise<number> {
  const response = await localRequest(port, "/snapshot/tiingo");
  assert.equal(response.status, 200, response.body);
  const value: unknown = JSON.parse(response.body);
  assert.ok(value && typeof value === "object" && "bytes" in value && typeof value.bytes === "number" && Number.isFinite(value.bytes));
  return value.bytes;
}

async function stopChild(processToStop: ChildProcess): Promise<void> {
  // A failed spawn emits "error" without starting a process or emitting "exit".
  if (!processToStop.pid || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  const kill = (signal: NodeJS.Signals) => {
    if (!processToStop.pid) return;
    try {
      // Only the isolated process group created by this test is signalled.
      if (process.platform === "win32") processToStop.kill(signal);
      else process.kill(-processToStop.pid, signal);
    } catch { /* Already exited. */ }
  };
  const stopped = new Promise<void>((resolve) => processToStop.once("exit", () => resolve()));
  kill("SIGTERM");
  const force = setTimeout(() => kill("SIGKILL"), 3_000);
  try { await stopped; } finally { clearTimeout(force); }
}

async function startRuntime(port: number): Promise<void> {
  logs = "";
  let spawnError: Error | undefined;
  child = spawn(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", persistence], {
    cwd: temporary, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(temporary, "wrangler.log"), CI: "true" },
  });
  child.once("error", (error) => { spawnError = error; });
  const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-8_000); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Local budget Worker exited: ${logs}`);
    try {
      if ((await localRequest(port, "/healthz")).status === 200) return;
    } catch { /* Wait for this test's local runtime to start. */ }
    await delay(100);
  }
  throw new Error(`Local budget Worker did not become ready: ${logs}`);
}

try {
  const port = await unusedPort();
  const entry = join(temporary, "entry.mjs");
  // All budget mutations execute inherited production RPC methods. The only
  // added method reads the real SQLite total so repeated settlement is observable.
  // This wrapper exists only in a temporary local config, never the deploy entry.
  await writeFile(entry, `
import { ProviderBudget as Implementation } from ${JSON.stringify(join(root, "worker/durable-objects/provider-budget.ts"))};
globalThis.fetch = async () => { throw new Error("External fetch blocked in local budget regression"); };
export class ProviderBudget extends Implementation {
  snapshot() {
    const rows = this.ctx.storage.sql.exec("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM byte_buckets").toArray();
    return { bytes: rows[0].bytes };
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== "127.0.0.1" || request.headers.get("x-test-token") !== env.TEST_RPC_TOKEN) return new Response(null, { status: 404 });
    if (request.method === "GET" && url.pathname === "/healthz") return new Response("ready");
    const match = /^\\/(reserve|settle|snapshot)\\/(yahoo|tushare|tiingo)$/.exec(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    const [, operation, source] = match;
    const stub = env.LOCAL_PROVIDER_BUDGET.getByName(source);
    if (operation === "snapshot" && request.method === "GET") return Response.json(await stub.snapshot());
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const input = await request.json();
    if (operation === "reserve") return Response.json(await stub.reserve({ source, symbol: input.symbol }));
    if (operation === "settle") {
      await stub.settle({ reservationId: input.reservationId, bytes: input.bytes });
      return Response.json({ settled: true });
    }
    return new Response(null, { status: 405 });
  }
};
`);
  await writeFile(config, JSON.stringify({
    name: "quant-data-provider-budget-regression", main: entry,
    compatibility_date: "2026-08-08", compatibility_flags: ["nodejs_compat"],
    durable_objects: { bindings: [{ name: "LOCAL_PROVIDER_BUDGET", class_name: "ProviderBudget" }] },
    migrations: [{ tag: "local-v1", new_sqlite_classes: ["ProviderBudget"] }],
    vars: { TEST_RPC_TOKEN: rpcToken },
  }));
  await startRuntime(port);

  const concurrent = await Promise.all(Array.from({ length: 41 }, () => reserve(port, "tushare", "600519.SH")));
  const accepted = concurrent.filter((result) => result.allowed);
  const rejected = concurrent.filter((result) => !result.allowed);
  assert.equal(accepted.length, 40, "Concurrent requests must not overspend the global Tushare minute budget");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].retryAfterSeconds && rejected[0].retryAfterSeconds > 0);
  console.log("PASS 41 concurrent Tushare RPC reservations: exactly 40 allowed, 1 rejected (real SQLite DO)");

  const tiingo = await reserve(port, "tiingo", "AAPL");
  assert.equal(tiingo.allowed, true, "Tushare usage must not consume Tiingo's quota");
  const tiingoReservationId = tiingo.reservationId;
  assert.ok(tiingoReservationId);
  assert.equal(await byteTotal(port), 6 * 1024 * 1024, "Tiingo reserves bytes before the request");
  await Promise.all(Array.from({ length: 5 }, () => settle(port, tiingoReservationId, 1_024)));
  const settledBytes = await byteTotal(port);
  assert.equal(settledBytes, 1_024 + 16 * 1024, "Settlement keeps actual payload bytes and the transport allowance");
  await Promise.all(Array.from({ length: 5 }, () => settle(port, tiingoReservationId, 2_048)));
  assert.equal(await byteTotal(port), settledBytes, "Repeated settlement must not release or charge bytes twice");
  console.log("PASS Tiingo byte reservation and concurrent repeated settlement are idempotent");

  const yahoo = await reserve(port, "yahoo", "AAPL");
  assert.equal(yahoo.allowed, true, "Other providers must not consume Yahoo's quota");
  assert.equal((await reserve(port, "yahoo", "AAPL")).allowed, false);
  console.log("PASS provider budgets are isolated; Yahoo's second minute reservation is rejected");

  // Restart the complete runtime with exactly the same namespace, object names,
  // and SQLite persistence directory. No fixture repopulates the counters.
  assert.ok(child);
  await stopChild(child);
  child = undefined;
  await startRuntime(port);
  const afterRestart = await reserve(port, "yahoo", "AAPL");
  assert.equal(afterRestart.allowed, false, "Restarting workerd must not reset Yahoo's active quota");
  assert.ok(afterRestart.retryAfterSeconds && afterRestart.retryAfterSeconds > 0);
  assert.equal(await byteTotal(port), settledBytes, "Settled byte usage must survive a runtime restart");
  await settle(port, tiingoReservationId, 4_096);
  assert.equal(await byteTotal(port), settledBytes, "The settlement marker must also survive restart");
  console.log("PASS runtime restart preserves Yahoo quota and Tiingo settlement state in SQLite");
} finally {
  if (child) await stopChild(child);
  await rm(temporary, { recursive: true, force: true });
}
