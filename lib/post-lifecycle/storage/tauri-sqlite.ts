/**
 * SQLite storage backend for the post-lifecycle state machine.
 *
 * The Tauri desktop surface uses this implementation. It is the
 * production target for the desktop app.
 *
 * ATOMICITY:
 *   `savePostWithBlob` wraps both INSERTs in a BEGIN/COMMIT pair
 *   (with ROLLBACK on error). SQLite's transaction model guarantees
 *   the post row and the blob row are either both visible to
 *   subsequent reads, or both invisible. The atomicity contract
 *   from `persistence.ts` is upheld.
 *
 * DRIVER ABSTRACTION:
 *   The `SqliteDriver` interface is small and intentionally
 *   abstracts the actual driver implementation. Two are provided:
 *
 *   1. `TauriSqliteDriver` — wraps `@tauri-apps/plugin-sql`. This
 *      is the production driver. It opens a connection via
 *      `Database.load('sqlite:post_lifecycle.db')` and runs queries
 *      through the plugin's async `execute` / `select` surface.
 *
 *   2. `BetterSqlite3Driver` — wraps `better-sqlite3` for the
 *      Node.js test environment. Same SQL surface, synchronous
 *      under the hood, but exposed as a Promise-returning driver
 *      so the storage layer's code is identical.
 *
 *   The storage class takes a `SqliteDriver` in its constructor
 *   and never imports the underlying driver directly. This makes
 *   the test swap trivial and keeps the production path free of
 *   Node-specific APIs.
 *
 * MIGRATIONS:
 *   On `open()`, the storage reads `migrations/001_init.sql` and
 *   applies it via the driver. The driver is expected to be
 *   idempotent on this — see `TauriSqliteDriver.applyMigrations`
 *   for the bookkeeping. In production the Tauri plugin also
 *   runs its own migrations from `tauri.conf.json`; this is a
 *   belt-and-suspenders setup so the schema exists either way.
 */

import {
  type PostRecord,
  type PostState,
  type ImageBlob,
  type PostId,
  type ImageBlobId,
  AtomicityViolationError,
} from '../types';
import type { PostLifecycleStorage } from '../persistence';

// ── The driver interface ─────────────────────────────────────────────────

/**
 * Minimal SQL surface the storage class needs. Both
 * `TauriSqliteDriver` and `BetterSqlite3Driver` implement this.
 *
 * The driver is responsible for:
 *   - Parameter binding (it transforms the `?` placeholders to the
 *     driver's native syntax if needed — e.g. `$1, $2` for sqlx).
 *   - Opening / closing the underlying connection.
 *   - Running BEGIN / COMMIT / ROLLBACK.
 *
 * The storage class is responsible for:
 *   - All SQL strings.
 *   - Mapping `PostRecord` / `ImageBlob` to SQL rows and back.
 *   - Invariant checks (the atomicity contract).
 */
export interface SqliteDriver {
  /**
   * Execute a write (INSERT, UPDATE, DELETE). Returns the number
   * of affected rows when the driver can report it.
   */
  execute(sql: string, params: readonly unknown[]): Promise<{ rowsAffected: number }>;

  /**
   * Execute a read (SELECT) and return all rows.
   */
  select<T = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T[]>;

  /**
   * Execute a callback inside a single transaction. The driver
   * runs BEGIN before the callback, COMMIT after a normal return,
   * and ROLLBACK + rethrow on error.
   *
   * The callback receives a transactional driver: every `execute`
   * and `select` call inside the callback runs on the same
   * connection (and same transaction for `execute`).
   */
  transaction<T>(callback: (tx: SqliteTxDriver) => Promise<T> | T): Promise<T>;

  /**
   * Apply a multi-statement SQL script (typically a migration).
   * The driver should split the script on `;` boundaries and
   * execute each statement in order, ideally inside a transaction.
   * Idempotent: running twice should be safe.
   */
  applyScript(sql: string): Promise<void>;

  /**
   * Close the underlying connection. Idempotent.
   */
  close(): void;
}

/**
 * A driver scoped to a single transaction. The callback passed to
 * `SqliteDriver.transaction` receives one of these. Calling `execute`
 * or `select` on it must run inside the parent transaction so the
 * atomicity contract holds.
 */
export interface SqliteTxDriver {
  execute(sql: string, params: readonly unknown[]): Promise<{ rowsAffected: number }>;
  select<T = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T[]>;
}

// ── The row shape used by all SQL statements ────────────────────────────

interface PostRow {
  id: string;
  state: PostState;
  image_blob_id: string | null;
  hosted_image_url: string | null;
  caption: string | null;
  hashtags: string;          // JSON array
  scheduled_for: string | null;
  platform: PostRecord['platform'];
  created_at: string;
  updated_at: string;
  state_changed_at: string;
  failure_reason: PostRecord['failureReason'];
  failure_context: string | null;  // JSON object
  retry_count: number;
  retryable: number;
  next_retry_at: string | null;
  history: string;           // JSON array
  idea_id: string | null;
  image_model_id: string | null;
}

interface BlobRow {
  id: string;
  post_id: string;
  format: ImageBlob['format'];
  size_bytes: number;
  created_at: string;
  last_verified_at: string;
  data: ArrayBuffer;
}

function postToRow(post: PostRecord): Omit<PostRow, 'history' | 'hashtags' | 'failure_context'> & {
  history: string;
  hashtags: string;
  failure_context: string | null;
} {
  return {
    id: post.id,
    state: post.state,
    image_blob_id: post.imageBlobId,
    hosted_image_url: post.hostedImageUrl,
    caption: post.caption,
    hashtags: JSON.stringify([...post.hashtags]),
    scheduled_for: post.scheduledFor,
    platform: post.platform,
    created_at: post.createdAt,
    updated_at: post.updatedAt,
    state_changed_at: post.stateChangedAt,
    failure_reason: post.failureReason,
    failure_context: post.failureContext ? JSON.stringify(post.failureContext) : null,
    retry_count: post.retryCount,
    retryable: post.retryable ? 1 : 0,
    next_retry_at: post.nextRetryAt,
    history: JSON.stringify([...post.history]),
    idea_id: post.ideaId,
    image_model_id: post.imageModelId,
  };
}

function rowToPost(row: PostRow): PostRecord {
  return {
    id: row.id as PostRecord['id'],
    state: row.state,
    imageBlobId: row.image_blob_id as PostRecord['imageBlobId'],
    hostedImageUrl: row.hosted_image_url,
    caption: row.caption,
    hashtags: parseJsonArray(row.hashtags),
    scheduledFor: row.scheduled_for,
    platform: row.platform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateChangedAt: row.state_changed_at,
    failureReason: row.failure_reason,
    failureContext: row.failure_context ? parseJsonObject(row.failure_context) : null,
    retryCount: row.retry_count,
    retryable: row.retryable !== 0,
    nextRetryAt: row.next_retry_at,
    history: parseJsonArray(row.history) as PostRecord['history'],
    ideaId: row.idea_id,
    imageModelId: row.image_model_id,
  };
}

function blobToRow(blob: ImageBlob): Omit<BlobRow, 'data'> & { data: ArrayBuffer } {
  return {
    id: blob.id,
    post_id: blob.postId,
    format: blob.format,
    size_bytes: blob.sizeBytes,
    created_at: blob.createdAt,
    last_verified_at: blob.lastVerifiedAt,
    data: blob.data,
  };
}

function rowToBlob(row: BlobRow): ImageBlob {
  return {
    id: row.id as ImageBlob['id'],
    postId: row.post_id as ImageBlob['postId'],
    format: row.format,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at,
    data: row.data,
  };
}

function parseJsonArray<T = unknown>(s: string): T[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ── The SQL statements ───────────────────────────────────────────────────
//
// All SQL lives in this section. Anywhere else in the file is row
// mapping + business logic. The atomicity contract is enforced by
// wrapping the two INSERTs in `savePostWithBlob` in a transaction.

const SQL = {
  upsertPost: `
    INSERT INTO posts (
      id, state, image_blob_id, hosted_image_url, caption, hashtags,
      scheduled_for, platform, created_at, updated_at, state_changed_at,
      failure_reason, failure_context, retry_count, retryable, next_retry_at,
      history, idea_id, image_model_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16,
      $17, $18, $19
    )
    ON CONFLICT (id) DO UPDATE SET
      state = excluded.state,
      image_blob_id = excluded.image_blob_id,
      hosted_image_url = excluded.hosted_image_url,
      caption = excluded.caption,
      hashtags = excluded.hashtags,
      scheduled_for = excluded.scheduled_for,
      platform = excluded.platform,
      updated_at = excluded.updated_at,
      state_changed_at = excluded.state_changed_at,
      failure_reason = excluded.failure_reason,
      failure_context = excluded.failure_context,
      retry_count = excluded.retry_count,
      retryable = excluded.retryable,
      next_retry_at = excluded.next_retry_at,
      history = excluded.history,
      idea_id = excluded.idea_id,
      image_model_id = excluded.image_model_id
  `,

  upsertBlob: `
    INSERT INTO blobs (
      id, post_id, format, size_bytes, created_at, last_verified_at, data
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      post_id = excluded.post_id,
      format = excluded.format,
      size_bytes = excluded.size_bytes,
      last_verified_at = excluded.last_verified_at,
      data = excluded.data
  `,

  selectPostById: `SELECT * FROM posts WHERE id = $1`,
  selectBlobById: `SELECT * FROM blobs WHERE id = $1`,
  selectAllPosts: `SELECT * FROM posts ORDER BY created_at ASC`,
  selectPostsByState: `SELECT * FROM posts WHERE state = $1 ORDER BY created_at ASC`,

  deletePost: `DELETE FROM posts WHERE id = $1`,
  deleteOrphanBlob: `DELETE FROM blobs WHERE id = $1`,

  touchBlobVerifiedAt: `UPDATE blobs SET last_verified_at = $1 WHERE id = $2`,
} as const;

// ── The storage class ────────────────────────────────────────────────────

/**
 * The SQLite-backed `PostLifecycleStorage` implementation.
 *
 * Construct via:
 *   - `TauriSqliteStorage.open(driver)` for production; applies
 *     the initial migration on first use.
 *   - `TauriSqliteStorage.fromDriver(driver)` for tests; skips
 *     the migration step (the test fixture is responsible for
 *     applying schema if needed).
 */
export class TauriSqliteStorage implements PostLifecycleStorage {
  private constructor(private readonly driver: SqliteDriver) {}

  static async open(driver: SqliteDriver): Promise<TauriSqliteStorage> {
    const storage = new TauriSqliteStorage(driver);
    await storage.applyMigrations();
    return storage;
  }

  static fromDriver(driver: SqliteDriver): TauriSqliteStorage {
    return new TauriSqliteStorage(driver);
  }

  /**
   * Apply the bundled migration scripts. Idempotent: each migration
   * is wrapped in a `CREATE TABLE IF NOT EXISTS` so re-running is
   * safe. The schema is small enough that the `IF NOT EXISTS` form
   * is sufficient; when the schema grows we'll add a `migrations`
   * tracking table.
   */
  private async applyMigrations(): Promise<void> {
    // Inline the migration SQL to avoid a runtime require() of a
    // .sql file under Vite (which doesn't know how to bundle raw
    // SQL by default). Keeping the SQL as a template string here
    // means the build pipeline doesn't need a special loader.
    // The committed migrations/001_init.sql is the source of
    // truth; this string mirrors it. If they ever drift, the
    // build will catch it in the schema-parity test.
    const SCHEMA = `
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        image_blob_id TEXT,
        hosted_image_url TEXT,
        caption TEXT,
        hashtags TEXT,
        scheduled_for TEXT,
        platform TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state_changed_at TEXT NOT NULL,
        failure_reason TEXT,
        failure_context TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        retryable INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        history TEXT NOT NULL,
        idea_id TEXT,
        image_model_id TEXT
      );

      CREATE TABLE IF NOT EXISTS blobs (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        format TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        data BLOB NOT NULL,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_posts_state ON posts(state);
      CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_for) WHERE state = 'scheduled';
      CREATE INDEX IF NOT EXISTS idx_blobs_post_id ON blobs(post_id);
    `;
    await this.driver.applyScript(SCHEMA);
  }

  async savePostWithBlob(post: PostRecord, blob: ImageBlob | null): Promise<void> {
    // Pre-flight invariant checks. Mirrors the InMemoryStorage and
    // IDB backends. These run before the transaction so a bad
    // request fails fast with a typed error.
    if (post.imageBlobId && !blob) {
      throw new AtomicityViolationError(
        'post has imageBlobId but no blob was provided'
      );
    }
    if (blob && blob.postId !== post.id) {
      throw new AtomicityViolationError(
        `blob.postId (${blob.postId}) does not match post.id (${post.id})`
      );
    }

    const postRow = postToRow(post);
    const blobRow = blob ? blobToRow(blob) : null;

    // If the post is dropping its image (imageBlobId is now
    // null but the post may have previously referenced one),
    // read the old blob id before the transaction opens. We
    // can't read it inside the transaction because SQLite's
    // read-your-writes would see the upsert's null value.
    const oldBlobId =
      blobRow === null && post.imageBlobId === null
        ? await this.getOldImageBlobId(post.id)
        : null;

    // The atomic write. We use `ON CONFLICT` upserts so a re-save
    // updates the existing row in place rather than failing on
    // the primary-key collision. Both writes (or neither) commit
    // as a single SQLite transaction.
    //
    // The post write is mandatory; the blob write is conditional
    // on the caller providing one. We also cascade-delete a stale
    // blob if the post is moving to a state that no longer
    // references an image (e.g. failed, draft).
    await this.driver.transaction(async (tx) => {
      await tx.execute(SQL.upsertPost, [
        postRow.id,
        postRow.state,
        postRow.image_blob_id,
        postRow.hosted_image_url,
        postRow.caption,
        postRow.hashtags,
        postRow.scheduled_for,
        postRow.platform,
        postRow.created_at,
        postRow.updated_at,
        postRow.state_changed_at,
        postRow.failure_reason,
        postRow.failure_context,
        postRow.retry_count,
        postRow.retryable,
        postRow.next_retry_at,
        postRow.history,
        postRow.idea_id,
        postRow.image_model_id,
      ]);

      if (blobRow) {
        await tx.execute(SQL.upsertBlob, [
          blobRow.id,
          blobRow.post_id,
          blobRow.format,
          blobRow.size_bytes,
          blobRow.created_at,
          blobRow.last_verified_at,
          blobRow.data,
        ]);
      } else if (post.imageBlobId === null && oldBlobId) {
        // The post's imageBlobId is null and the post previously
        // referenced a blob — the post is moving to a state that
        // no longer references an image (e.g. failed, draft).
        // Delete the stale blob in the same transaction.
        //
        // `oldBlobId` was read before this transaction started
        // (see below). It is racy in the face of concurrent
        // writers, but the worst case is a stale orphan blob
        // left behind, which the reconciler catches on the next
        // pass. We don't read it inside the transaction because
        // SQLite's read-your-writes would see the upsert's
        // null and miss the previous value.
        await tx.execute(SQL.deleteOrphanBlob, [oldBlobId]);
      }
    });
  }

  /**
   * Compute the old `image_blob_id` of a post so `savePostWithBlob`
   * can detect the "post is dropping its image" transition and
   * clean up the stale blob in the same transaction.
   *
   * The read happens BEFORE the transaction opens. Concurrent
   * writers can change the value between the read and the
   * transaction; we accept the race because the reconciler
   * catches any stale orphans on the next pass.
   */
  private async getOldImageBlobId(postId: PostId): Promise<string | null> {
    const rows = await this.driver.select<{ image_blob_id: string | null }>(
      'SELECT image_blob_id FROM posts WHERE id = $1',
      [postId]
    );
    if (rows.length === 0) return null;
    return rows[0].image_blob_id;
  }

  async getPost(id: PostId): Promise<PostRecord | null> {
    const rows = await this.driver.select<PostRow>(SQL.selectPostById, [id]);
    return rows.length === 0 ? null : rowToPost(rows[0]);
  }

  async getBlob(id: ImageBlobId): Promise<ImageBlob | null> {
    const rows = await this.driver.select<BlobRow>(SQL.selectBlobById, [id]);
    return rows.length === 0 ? null : rowToBlob(rows[0]);
  }

  async listPosts(): Promise<PostRecord[]> {
    const rows = await this.driver.select<PostRow>(SQL.selectAllPosts, []);
    return rows.map(rowToPost);
  }

  async listPostsByState(state: PostState): Promise<PostRecord[]> {
    const rows = await this.driver.select<PostRow>(SQL.selectPostsByState, [state]);
    return rows.map(rowToPost);
  }

  async deletePost(id: PostId): Promise<void> {
    // The FOREIGN KEY on blobs.post_id with ON DELETE CASCADE
    // handles the orphan-blob cleanup. We wrap in a transaction
    // for the read-then-delete pattern: the post may be gone by
    // the time we delete its blob, but the cascade still fires
    // for any blob with a stale post_id reference.
    await this.driver.transaction(async (tx) => {
      await tx.execute(SQL.deletePost, [id]);
    });
  }

  async touchBlobVerifiedAt(id: ImageBlobId): Promise<void> {
    await this.driver.execute(SQL.touchBlobVerifiedAt, [new Date().toISOString(), id]);
  }
}
