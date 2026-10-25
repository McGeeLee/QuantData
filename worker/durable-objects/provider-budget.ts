import { DurableObject } from "cloudflare:workers";
import {
  DAY_MS, HOUR_MS, MINUTE_MS, MONTH_MS, REQUEST_BUDGETS, TIINGO_BYTE_LIMIT, TIINGO_RESERVED_BYTES,
  TIINGO_SYMBOL_LIMIT, bucketStart, normalizeBudgetSymbol, retryAfterBucket, rollingBucketStart,
  settledTiingoBytes,
  type ReservationResult, type ReserveInput, type SettleInput,
} from "../services/provider-budget";

type Total = { total: number; first: number | null };

/** One stable named object per provider. No network calls or awaits inside accounting transactions. */
export class ProviderBudget extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_buckets (bucket INTEGER PRIMARY KEY, count INTEGER NOT NULL CHECK(count >= 0));
      CREATE TABLE IF NOT EXISTS request_hour_buckets (bucket INTEGER PRIMARY KEY, count INTEGER NOT NULL CHECK(count >= 0));
      CREATE TABLE IF NOT EXISTS byte_buckets (bucket INTEGER PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes >= 0));
      CREATE TABLE IF NOT EXISTS symbols (symbol TEXT PRIMARY KEY, last_seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS symbols_last_seen ON symbols(last_seen);
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, bucket INTEGER NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS reservations_created_at ON reservations(created_at);
    `);
  }

  reserve(input: ReserveInput): ReservationResult {
    if (!Object.hasOwn(REQUEST_BUDGETS, input.source)) throw new Error("Invalid budget source");
    const symbol = normalizeBudgetSymbol(input.symbol);
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const source = sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key = 'source'").toArray()[0]?.value;
      if (source && source !== input.source) throw new Error("Budget source mismatch");
      sql.exec("INSERT OR IGNORE INTO metadata(key, value) VALUES ('source', ?)", input.source);

      // Keep only active windows, including the complete oldest overlapping bucket.
      sql.exec("DELETE FROM request_buckets WHERE bucket < ?", rollingBucketStart(now, HOUR_MS, MINUTE_MS));
      sql.exec("DELETE FROM request_hour_buckets WHERE bucket < ?", rollingBucketStart(now, DAY_MS, HOUR_MS));
      sql.exec("DELETE FROM byte_buckets WHERE bucket < ?", rollingBucketStart(now, MONTH_MS, DAY_MS));
      sql.exec("DELETE FROM symbols WHERE last_seen <= ?", now - MONTH_MS);
      sql.exec("DELETE FROM reservations WHERE created_at <= ?", now - MONTH_MS);

      for (const policy of REQUEST_BUDGETS[input.source]) {
        const daily = policy.windowMs === DAY_MS;
        const width = daily ? HOUR_MS : MINUTE_MS;
        const current = sql.exec<Total>(
          daily
            ? "SELECT COALESCE(SUM(count), 0) AS total, MIN(bucket) AS first FROM request_hour_buckets WHERE bucket >= ?"
            : "SELECT COALESCE(SUM(count), 0) AS total, MIN(bucket) AS first FROM request_buckets WHERE bucket >= ?",
          rollingBucketStart(now, policy.windowMs, width),
        ).one();
        if (current.total >= policy.limit) {
          return {
            allowed: false, reason: policy.reason,
            retryAfterSeconds: retryAfterBucket(now, current.first ?? now, policy.windowMs, width),
          };
        }
      }

      if (input.source === "tiingo") {
        const existingSymbol = sql.exec<{ symbol: string }>("SELECT symbol FROM symbols WHERE symbol = ?", symbol).toArray()[0];
        if (!existingSymbol) {
          const distinct = sql.exec<Total>("SELECT COUNT(*) AS total, MIN(last_seen) AS first FROM symbols").one();
          if (distinct.total >= TIINGO_SYMBOL_LIMIT) {
            return {
              allowed: false, reason: "monthly_symbols",
              retryAfterSeconds: Math.max(1, Math.ceil(((distinct.first ?? now) + MONTH_MS - now) / 1_000)),
            };
          }
        }
        const bandwidth = sql.exec<Total>("SELECT COALESCE(SUM(bytes), 0) AS total, MIN(bucket) AS first FROM byte_buckets WHERE bytes > 0").one();
        if (bandwidth.total + TIINGO_RESERVED_BYTES > TIINGO_BYTE_LIMIT) {
          return {
            allowed: false, reason: "monthly_bytes",
            retryAfterSeconds: retryAfterBucket(now, bandwidth.first ?? now, MONTH_MS, DAY_MS),
          };
        }
      }

      const reservationId = crypto.randomUUID();
      sql.exec("INSERT INTO request_buckets(bucket, count) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1", bucketStart(now, MINUTE_MS));
      sql.exec("INSERT INTO request_hour_buckets(bucket, count) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1", bucketStart(now, HOUR_MS));
      if (input.source === "tiingo") {
        const byteBucket = bucketStart(now, DAY_MS);
        sql.exec("INSERT INTO byte_buckets(bucket, bytes) VALUES (?, ?) ON CONFLICT(bucket) DO UPDATE SET bytes = bytes + excluded.bytes", byteBucket, TIINGO_RESERVED_BYTES);
        sql.exec("INSERT INTO reservations(id, created_at, bucket) VALUES (?, ?, ?)", reservationId, now, byteBucket);
        sql.exec("INSERT INTO symbols(symbol, last_seen) VALUES (?, ?) ON CONFLICT(symbol) DO UPDATE SET last_seen = excluded.last_seen", symbol, now);
      }
      return { allowed: true, reservationId };
    });
  }

  settle(input: SettleInput): void {
    const chargedBytes = settledTiingoBytes(input.bytes);
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const reservation = sql.exec<{ bucket: number; settled: number }>("SELECT bucket, settled FROM reservations WHERE id = ?", input.reservationId).toArray()[0];
      // Unknown/expired reservations and duplicate acknowledgements cannot refund anything.
      if (!reservation || reservation.settled) return;
      sql.exec("UPDATE byte_buckets SET bytes = MAX(0, bytes - ?) WHERE bucket = ?", TIINGO_RESERVED_BYTES - chargedBytes, reservation.bucket);
      sql.exec("UPDATE reservations SET settled = 1 WHERE id = ?", input.reservationId);
    });
  }
}
