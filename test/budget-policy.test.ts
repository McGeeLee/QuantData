import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderBudget } from "../worker/durable-objects/provider-budget";
import {
  DAY_MS, HOUR_MS, MINUTE_MS, MONTH_MS, RESPONSE_OVERHEAD_BYTES, TIINGO_BYTE_LIMIT,
  TIINGO_RESERVED_BYTES, bucketStart, normalizeBudgetSymbol, settledTiingoBytes,
} from "../worker/services/provider-budget";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

const databases: DatabaseSync[] = [];
const BASE = Date.UTC(2026, 0, 1);

function ledger() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const state = {
    storage: {
      sql: {
        exec(query: string, ...bindings: (string | number | null)[]) {
          if (query.includes("CREATE TABLE")) {
            db.exec(query);
            return;
          }
          const rows = db.prepare(query).all(...bindings);
          return { toArray: () => rows, one: () => {
            if (rows.length !== 1) throw new Error("Expected one row");
            return rows[0];
          } };
        },
      },
      transactionSync<T>(operation: () => T): T {
        db.exec("BEGIN");
        try {
          const value = operation();
          db.exec("COMMIT");
          return value;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  } as unknown as DurableObjectState;
  return { db, object: new ProviderBudget(state, {} as Env) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

describe("durable provider budget accounting", () => {
  it("atomically permits 40 Tushare calls then refuses without increasing counters", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    const { db, object } = ledger();
    for (let n = 0; n < 40; n++) expect(object.reserve({ source: "tushare", symbol: "600519.SH" }).allowed).toBe(true);
    expect(object.reserve({ source: "tushare", symbol: "600519.SH" })).toEqual({
      allowed: false, reason: "minute_requests", retryAfterSeconds: 120,
    });
    expect(db.prepare("SELECT SUM(count) AS total FROM request_hour_buckets").get()?.total).toBe(40);
    expect(() => object.reserve({ source: "tiingo", symbol: "AAPL" })).toThrow("source mismatch");
  });

  it("retains the whole overlapping minute at rolling-window boundaries", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(BASE + MINUTE_MS - 1);
    const { object } = ledger();
    expect(object.reserve({ source: "yahoo", symbol: "AAPL" }).allowed).toBe(true);
    clock.mockReturnValue(BASE + MINUTE_MS * 2 - 1);
    expect(object.reserve({ source: "yahoo", symbol: "AAPL" })).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    clock.mockReturnValue(BASE + MINUTE_MS * 2);
    expect(object.reserve({ source: "yahoo", symbol: "AAPL" }).allowed).toBe(true);
  });

  it("caps daily calls from a bounded hourly aggregate and does not expire its overlap early", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(BASE + DAY_MS);
    const { db, object } = ledger();
    db.prepare("INSERT INTO request_hour_buckets VALUES (?, ?)").run(BASE, 6_400);
    expect(object.reserve({ source: "tushare", symbol: "600519.SH" })).toEqual({
      allowed: false, reason: "day_requests", retryAfterSeconds: 3_600,
    });
    clock.mockReturnValue(BASE + DAY_MS + HOUR_MS);
    expect(object.reserve({ source: "tushare", symbol: "600519.SH" }).allowed).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS total FROM request_hour_buckets").get()?.total).toBe(1);
  });

  it("enforces both Tiingo hourly and daily call caps independently of refunds", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(BASE);
    const { db, object } = ledger();
    for (let n = 0; n < 40; n++) {
      const reservation = object.reserve({ source: "tiingo", symbol: "AAPL" });
      if (!reservation.allowed) throw new Error("Expected reservation");
      object.settle({ reservationId: reservation.reservationId, bytes: 0 });
    }
    expect(object.reserve({ source: "tiingo", symbol: "AAPL" })).toMatchObject({ allowed: false, reason: "hour_requests" });
    clock.mockReturnValue(BASE + HOUR_MS + MINUTE_MS);
    db.prepare("UPDATE request_hour_buckets SET count = 800").run();
    expect(object.reserve({ source: "tiingo", symbol: "AAPL" })).toMatchObject({ allowed: false, reason: "day_requests" });
  });

  it("refunds only Tiingo bytes, once, never request counts or symbol usage", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    const { db, object } = ledger();
    const reservation = object.reserve({ source: "tiingo", symbol: " aapl " });
    expect(reservation.allowed).toBe(true);
    if (!reservation.allowed) throw new Error("Expected allowed reservation");
    expect(db.prepare("SELECT bytes FROM byte_buckets").get()?.bytes).toBe(TIINGO_RESERVED_BYTES);
    object.settle({ reservationId: reservation.reservationId, bytes: 123 });
    object.settle({ reservationId: reservation.reservationId, bytes: 0 });
    object.settle({ reservationId: "unknown", bytes: 0 });
    expect(db.prepare("SELECT bytes FROM byte_buckets").get()?.bytes).toBe(123 + RESPONSE_OVERHEAD_BYTES);
    expect(db.prepare("SELECT count FROM request_hour_buckets").get()?.count).toBe(1);
    expect(db.prepare("SELECT symbol FROM symbols").get()?.symbol).toBe("AAPL");
    expect(() => object.settle({ reservationId: reservation.reservationId, bytes: -1 })).toThrow();
  });

  it("blocks new symbols at 400 but accepts existing ones and expires last-seen exactly", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(BASE);
    const { db, object } = ledger();
    const insert = db.prepare("INSERT INTO symbols VALUES (?, ?)");
    for (let n = 0; n < 400; n++) insert.run(`S${n}`, BASE);
    expect(object.reserve({ source: "tiingo", symbol: "NEW" })).toMatchObject({ allowed: false, reason: "monthly_symbols" });
    expect(object.reserve({ source: "tiingo", symbol: "s0" }).allowed).toBe(true);
    clock.mockReturnValue(BASE + MONTH_MS);
    expect(object.reserve({ source: "tiingo", symbol: "NEW" }).allowed).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS total FROM symbols").get()?.total).toBe(1);
  });

  it("requires enough space for the full reservation and conservatively retains an overlapping byte day", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(BASE + MONTH_MS);
    const { db, object } = ledger();
    db.prepare("INSERT INTO byte_buckets VALUES (?, ?)").run(BASE, TIINGO_BYTE_LIMIT - TIINGO_RESERVED_BYTES + 1);
    expect(object.reserve({ source: "tiingo", symbol: "AAPL" })).toEqual({
      allowed: false, reason: "monthly_bytes", retryAfterSeconds: 86_400,
    });
    expect(db.prepare("SELECT COUNT(*) AS total FROM reservations").get()?.total).toBe(0);
    clock.mockReturnValue(BASE + MONTH_MS + DAY_MS);
    expect(object.reserve({ source: "tiingo", symbol: "AAPL" }).allowed).toBe(true);
    expect(db.prepare("SELECT bytes FROM byte_buckets").get()?.bytes).toBe(TIINGO_RESERVED_BYTES);
  });

  it("rolls back counters and reservations together if a later durable write fails", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    const { db, object } = ledger();
    db.exec("CREATE TRIGGER fail_reservation BEFORE INSERT ON reservations BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    expect(() => object.reserve({ source: "tiingo", symbol: "AAPL" })).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS total FROM request_buckets").get()?.total).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS total FROM byte_buckets").get()?.total).toBe(0);
  });

  it("rejects invalid symbol and settlement inputs", () => {
    expect(normalizeBudgetSymbol(" BRK-B ")).toBe("BRK-B");
    expect(bucketStart(BASE + 42_000, MINUTE_MS)).toBe(BASE);
    for (const symbol of ["", " ", "A/B", "a".repeat(65)]) expect(() => normalizeBudgetSymbol(symbol)).toThrow();
    for (const bytes of [-1, 0.5, NaN, Infinity, 5 * 1024 * 1024 + 1]) expect(() => settledTiingoBytes(bytes)).toThrow();
  });
});
