/**
 * `better-sqlite3` driver — used by the test suite as a mock for
 * `tauri-plugin-sql`. Lives in the storage/ directory so the
 * production build can tree-shake it out: importing this file
 * pulls in `better-sqlite3`, which is a Node-only native module.
 * The production code path never imports this file.
 *
 * The driver's API matches `SqliteDriver` exactly. Internally it
 * wraps a synchronous better-sqlite3 connection so the storage
 * class's async code works unchanged.
 *
 * USAGE IN TESTS:
 *   import Database from 'better-sqlite3';
 *   import { BetterSqlite3Driver } from '@/lib/post-lifecycle/storage/better-sqlite3-driver';
 *
 *   const raw = new Database(':memory:');
 *   const driver = new BetterSqlite3Driver(raw);
 *   const storage = TauriSqliteStorage.fromDriver(driver);
 *
 * Placeholders: the storage uses `$1, $2, ...` (sqlx-style). This
 * driver rewrites them to `?, ?, ...` (better-sqlite3-style)
 * before preparing the statement, so the test SQL is byte-for-byte
 * identical to the production SQL.
 *
 * ASYNC-WITH-SYNC-DRIVER NOTE:
 *   better-sqlite3's `db.transaction(fn)` wrapper requires a
 *   synchronous callback (it commits on return, not on Promise
 *   resolve). Our `SqliteDriver` interface is async because the
 *   production Tauri driver is async. We bridge the two by
 *   manually issuing BEGIN/COMMIT/ROLLBACK around the async
 *   callback. This is safe because every async step in the
 *   callback resolves synchronously against the better-sqlite3
 *   connection (the `Promise.resolve()` wrapping is the only
 *   async cost) — the entire callback's body completes within
 *   a single event-loop tick. SQLite never sees a partial
 *   transaction.
 */

import type Database from 'better-sqlite3';
import type { SqliteDriver, SqliteTxDriver } from './tauri-sqlite';

type BetterSqlite3Db = ReturnType<typeof Database>;

export class BetterSqlite3Driver implements SqliteDriver {
  constructor(private readonly db: BetterSqlite3Db) {}

  async execute(
    sql: string,
    params: readonly unknown[]
  ): Promise<{ rowsAffected: number }> {
    const stmt = this.db.prepare(rewritePlaceholders(sql));
    const info = stmt.run(...params.map(coerceForBetterSqlite3));
    return { rowsAffected: info.changes };
  }

  async select<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[]
  ): Promise<T[]> {
    const stmt = this.db.prepare(rewritePlaceholders(sql));
    return stmt.all(...params.map(coerceForBetterSqlite3)) as T[];
  }

  async transaction<T>(
    callback: (tx: SqliteTxDriver) => Promise<T> | T
  ): Promise<T> {
    // Manual BEGIN/COMMIT/ROLLBACK. We do NOT use
    // `db.transaction(callback)` because that wrapper commits
    // synchronously on return — it doesn't await the Promise the
    // callback returns. See the file-level comment.
    this.db.exec('BEGIN');
    let result: T;
    try {
      const txDriver: SqliteTxDriver = {
        execute: async (sql, params) => {
          const stmt = this.db.prepare(rewritePlaceholders(sql));
          const info = stmt.run(...params.map(coerceForBetterSqlite3));
          return { rowsAffected: info.changes };
        },
        select: async <U = Record<string, unknown>>(sql: string, params: readonly unknown[]) => {
          const stmt = this.db.prepare(rewritePlaceholders(sql));
          return stmt.all(...params.map(coerceForBetterSqlite3)) as U[];
        },
      };
      result = await callback(txDriver);
      this.db.exec('COMMIT');
    } catch (err) {
      // ROLLBACK is best-effort. If the connection is already in
      // an error state, the ROLLBACK will throw; we swallow that
      // and re-throw the original error.
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore — the original error is what matters
      }
      throw err;
    }
    return result;
  }

  async applyScript(sql: string): Promise<void> {
    // better-sqlite3's `db.exec()` runs multi-statement SQL and
    // is idempotent for `CREATE TABLE IF NOT EXISTS`.
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Rewrite `$1, $2, ...` placeholders to `?, ?, ...` for the
 * better-sqlite3 driver. The production `TauriSqliteDriver` keeps
 * the sqlx-style `$N` placeholders because that's what
 * `tauri-plugin-sql` expects. The two drivers therefore accept
 * the same SQL strings from the storage class.
 */
function rewritePlaceholders(sql: string): string {
  return sql.replace(/\$\d+/g, '?');
}

/**
 * better-sqlite3 cannot bind `ArrayBuffer` directly — it requires
 * a `Buffer` (or Uint8Array). The production tauri-plugin-sql
 * accepts ArrayBuffer because sqlx accepts byte slices. We
 * normalise on the test-driver side so the storage class's
 * binding code is identical for both backends.
 *
 * The `ImageBlob.data` field is typed as `ArrayBuffer` (per the
 * `types.ts` contract). This coercion is the only spot in the
 * project that needs to know about the difference.
 */
function coerceForBetterSqlite3(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return value;
}
