/**
 * `tauri-plugin-sql` driver — production driver for the Tauri
 * desktop surface.
 *
 * This is the only file in `lib/post-lifecycle/storage/` that
 * imports `@tauri-apps/plugin-sql`. The plugin's `Database` class
 * is dynamically imported so importing this module outside the
 * Tauri runtime (e.g. in a Next.js client bundle, in vitest, or
 * in `next build`) does not crash with a "window.__TAURI__ is
 * not defined" error.
 *
 * Why dynamic import:
 *   `@tauri-apps/plugin-sql` reads `window.__TAURI_INTERNALS__`
 *   at module evaluation time in some versions. In the browser
 *   / Node-only paths, that global is undefined and the import
 *   throws. Dynamic `import()` defers the read until the driver
 *   is actually used, which is always inside the Tauri runtime.
 *
 * USAGE:
 *   import { TauriSqliteDriver } from '@/lib/post-lifecycle/storage/tauri-driver';
 *
 *   const driver = await TauriSqliteDriver.open('sqlite:post_lifecycle.db');
 *   const storage = await TauriSqliteStorage.open(driver);
 *
 *   // ... use storage ...
 *
 *   driver.close();
 */

import type { SqliteDriver, SqliteTxDriver } from './tauri-sqlite';

/**
 * The subset of `@tauri-apps/plugin-sql`'s `Database` class that
 * we actually use. We type the plugin as `unknown` in `loadPlugin`
 * and only rely on this minimal surface so a future plugin update
 * that changes unrelated methods doesn't break the storage.
 */
interface TauriDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  select<T = Record<string, unknown>>(query: string, bindValues?: unknown[]): Promise<T[]>;
  close(): Promise<boolean>;
}

let pluginLoadPromise: Promise<{ default: { load: (path: string) => Promise<TauriDatabase> } }> | null = null;

async function loadPlugin() {
  // The plugin module is resolved lazily. The first call to
  // `TauriSqliteDriver.open()` triggers the import; subsequent
  // calls reuse the same promise.
  if (pluginLoadPromise === null) {
    pluginLoadPromise = import('@tauri-apps/plugin-sql');
  }
  const mod = await pluginLoadPromise;
  if (!mod) {
    throw new Error('Failed to load @tauri-apps/plugin-sql');
  }
  return mod;
}

export class TauriSqliteDriver implements SqliteDriver {
  private constructor(private readonly db: TauriDatabase) {}

  static async open(path: string): Promise<TauriSqliteDriver> {
    const mod = await loadPlugin();
    const db = await mod.default.load(path);
    return new TauriSqliteDriver(db);
  }

  async execute(
    sql: string,
    params: readonly unknown[]
  ): Promise<{ rowsAffected: number }> {
    // The Tauri plugin already supports `$N` placeholders (it's
    // built on sqlx). No rewriting needed.
    const result = await this.db.execute(sql, [...params]);
    return { rowsAffected: result.rowsAffected };
  }

  async select<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[]
  ): Promise<T[]> {
    return this.db.select<T>(sql, [...params]);
  }

  async transaction<T>(
    callback: (tx: SqliteTxDriver) => Promise<T> | T
  ): Promise<T> {
    // The tauri-plugin-sql does not expose a `transaction()`
    // method. We use the BEGIN/COMMIT/ROLLBACK pattern that the
    // Tauri community has converged on (see plugins-workspace
    // issue #886). This is atomic because:
    //   1. The plugin's `execute` runs each statement on the
    //      same connection (it owns a single sqlx pool per
    //      `Database` instance).
    //   2. SQLite is in transaction mode between BEGIN and
    //      COMMIT; intermediate statements are not visible to
    //      other connections.
    //   3. On error we ROLLBACK before re-throwing.
    let result: T;
    try {
      await this.db.execute('BEGIN');
      const txDriver: SqliteTxDriver = {
        execute: async (sql, params) => {
          const r = await this.db.execute(sql, [...params]);
          return { rowsAffected: r.rowsAffected };
        },
        select: <U = Record<string, unknown>>(sql: string, params: readonly unknown[]) =>
          this.db.select<U>(sql, [...params]),
      };
      result = await callback(txDriver);
      await this.db.execute('COMMIT');
    } catch (err) {
      // Best-effort ROLLBACK. If the connection is broken, the
      // ROLLBACK will throw; we swallow that and re-throw the
      // original error so callers see the real cause.
      try {
        await this.db.execute('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
    return result;
  }

  async applyScript(sql: string): Promise<void> {
    // The plugin doesn't have an `exec` that runs multiple
    // statements, so we split on `;` and execute each. This is
    // good enough for our migration scripts which are well-
    // formed CREATE TABLE / CREATE INDEX statements. For ad-hoc
    // multi-statement scripts that include semicolons inside
    // string literals or trigger bodies, callers should use a
    // proper migration runner.
    const statements = sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await this.db.execute(stmt);
    }
  }

  close(): void {
    // Close is async on the Tauri plugin. We don't await it here
    // because the SqliteDriver interface is sync-close. Callers
    // that need to wait for the close should call
    // `TauriSqliteDriver.closeAsync()` instead.
    void this.db.close();
  }

  async closeAsync(): Promise<void> {
    await this.db.close();
  }
}
