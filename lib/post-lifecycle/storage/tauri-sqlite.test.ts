/**
 * Tests for the SQLite storage backend.
 *
 * The production driver is `TauriSqliteDriver`, which wraps
 * `@tauri-apps/plugin-sql`. That plugin requires the Tauri runtime,
 * so it can't run in a Node.js test environment.
 *
 * For these tests we use `BetterSqlite3Driver` — a drop-in
 * implementation of the same `SqliteDriver` interface, backed by
 * an in-memory `better-sqlite3` database. The storage class under
 * test (`TauriSqliteStorage`) is identical for both drivers, so
 * these tests cover all the storage-layer logic: SQL generation,
 * parameter binding, transaction wrapping, and atomicity.
 *
 * ENVIRONMENT:
 *   better-sqlite3 is a native module that doesn't load under
 *   jsdom. We use the per-file `// @vitest-environment node`
 *   directive to force Node for this file. (See vitest.config.ts
 *   for the project-wide default of jsdom.)
 */

// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';

import { BetterSqlite3Driver } from './better-sqlite3-driver';
import { TauriSqliteStorage } from './tauri-sqlite';
import type { SqliteDriver, SqliteTxDriver } from './tauri-sqlite';
import {
  AtomicityViolationError,
  createDraftPost,
  ImageBlobId,
  PostId,
  Reconciler,
  transition,
  type ImageBlob,
} from '../';

// V1.5.2: detect whether better-sqlite3's NATIVE binding is loadable in
// this environment, WITHOUT a static `import` (better-sqlite3 requires the
// binding at module-load time, so a static import would crash the whole
// test file before any guard could run). We load it dynamically inside a
// try/catch: CI (and any machine that compiled the binding) gets the real
// module and runs the full suite; a dev box where the binding was never
// built — e.g. a stray pnpm store that skipped the native build — flips
// the skip flag instead of hard-failing `vitest run` (which was forcing
// `--no-verify` on every local commit). Binding availability is an
// ENVIRONMENT property, not a code-correctness one. CI keeps full coverage.
type BetterSqlite3Ctor = typeof import('better-sqlite3');
let Database: BetterSqlite3Ctor | null = null;
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  // better-sqlite3 is CommonJS (`export = Database`); the dynamic import
  // surfaces the constructor as `.default` under esModuleInterop, or as
  // the namespace itself otherwise — accept either.
  Database = (mod as { default?: BetterSqlite3Ctor }).default ?? (mod as unknown as BetterSqlite3Ctor);
  new Database(':memory:').close();
} catch {
  sqliteAvailable = false;
   
  console.warn(
    '[tauri-sqlite.test] better-sqlite3 native binding unavailable — skipping '
      + 'SQLite storage tests locally. Run `npm rebuild better-sqlite3` (or a clean '
      + '`bun install`) to enable them. CI builds the binding and runs them.',
  );
}
/** describe() on a machine with the binding, describe.skip() without it. */
const describeSqlite = sqliteAvailable ? describe : describe.skip;

const TEST_DATA = new ArrayBuffer(8);

function makeBlob(postId: PostId, id: ImageBlobId = ImageBlobId('blob_abcdef')): ImageBlob {
  return {
    id,
    postId,
    format: 'jpeg',
    sizeBytes: TEST_DATA.byteLength,
    createdAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    data: TEST_DATA,
  };
}

async function makeStorage(): Promise<{
  storage: TauriSqliteStorage;
  driver: BetterSqlite3Driver;
}> {
  // Each test gets a fresh in-memory database. better-sqlite3
  // creates a new database per `new Database(':memory:')` call, so
  // there's no cross-test contamination. `Database!` is safe: these
  // tests only run inside `describeSqlite`, which is skipped when the
  // binding (and thus `Database`) is unavailable.
  const raw = new Database!(':memory:');
  const driver = new BetterSqlite3Driver(raw);
  const storage = await TauriSqliteStorage.open(driver);
  return { storage, driver };
}

describeSqlite('TauriSqliteStorage: schema migration on open', () => {
  it('creates posts and blobs tables on first open', async () => {
    const { driver } = await makeStorage();
    // Use the underlying better-sqlite3 to inspect the schema. We
    // re-use the raw `db` via the driver, but better-sqlite3 is
    // sync so we can also just exec via the driver.
    const tables = await driver.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      []
    );
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('posts');
    expect(tableNames).toContain('blobs');
  });

  it('creates the expected indexes', async () => {
    const { driver } = await makeStorage();
    const indexes = await driver.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      []
    );
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_posts_state');
    expect(indexNames).toContain('idx_posts_scheduled');
  });
});

describeSqlite('TauriSqliteStorage: atomicity contract', () => {
  it('savePostWithBlob writes both post and blob atomically', async () => {
    const { storage } = await makeStorage();
    const id = PostId('post_atomic01');
    const blobId = ImageBlobId('blob_atomic01');
    const post = createDraftPost({ id });
    post.imageBlobId = blobId;
    // Force state for test — see comment above.
    post.state = 'image_ready';
    const blob = makeBlob(id, blobId);

    await storage.savePostWithBlob(post, blob);

    const readPost = await storage.getPost(id);
    const readBlob = await storage.getBlob(blobId);
    expect(readPost).not.toBeNull();
    expect(readBlob).not.toBeNull();
    expect(readPost!.imageBlobId).toBe(blobId);
    expect(readBlob!.postId).toBe(id);
  });

  it('rejects a post with imageBlobId but no blob', async () => {
    const { storage } = await makeStorage();
    const id = PostId('post_atomic02');
    const post = createDraftPost({ id });
    post.imageBlobId = ImageBlobId('blob_atomic02');
    // Force state for test — see comment above.
    post.state = 'image_ready';

    await expect(
      storage.savePostWithBlob(post, null)
    ).rejects.toThrow(AtomicityViolationError);
  });

  it('rejects a blob whose postId does not match the post', async () => {
    const { storage } = await makeStorage();
    const id = PostId('post_atomic03');
    const blob = makeBlob(PostId('post_other1'), ImageBlobId('blob_atomic03'));

    await expect(
      storage.savePostWithBlob(createDraftPost({ id }), blob)
    ).rejects.toThrow(AtomicityViolationError);
  });

  it('blob data round-trips intact (BLOB column)', async () => {
    const { storage } = await makeStorage();
    const id = PostId('post_roundbin');
    const blobId = ImageBlobId('blob_roundbin');
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
    const post = createDraftPost({ id });
    post.imageBlobId = blobId;
    // Force state for test — see comment above.
    post.state = 'image_ready';
    const blob: ImageBlob = {
      id: blobId,
      postId: id,
      format: 'png',
      sizeBytes: buf.byteLength,
      createdAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
      data: buf,
    };

    await storage.savePostWithBlob(post, blob);

    const readBlob = await storage.getBlob(blobId);
    expect(readBlob).not.toBeNull();
    expect(new Uint8Array(readBlob!.data)).toEqual(bytes);
  });

  it('savePostWithBlob is wrapped in a real transaction (atomic on driver error)', async () => {
    // Verify the atomicity contract at the storage level by
    // simulating a driver-level failure mid-transaction. The
    // driver throws → the storage's transaction() block catches,
    // ROLLBACKs, and the post is not visible.
    //
    // We do this by wrapping the better-sqlite3 driver and
    // forcing an error on the second statement.
    const raw = new Database!(':memory:');
    const baseDriver = new BetterSqlite3Driver(raw);
    // Bootstrap the schema by opening the storage once.
    await TauriSqliteStorage.open(baseDriver);

    // Now construct a sabotaged driver. Every execute that writes
    // a `blobs` row throws — the second statement in
    // savePostWithBlob. The transaction should ROLLBACK, leaving
    // the `posts` row absent.
    //
    // We construct a complete SqliteDriver-compatible object so
    // TypeScript checks that every required method is present.
    // The `transaction` method is the only one we override; the
    // rest are forwarded to the base driver.
    const saboteur: SqliteDriver = {
      execute: baseDriver.execute.bind(baseDriver),
      select: baseDriver.select.bind(baseDriver),
      applyScript: baseDriver.applyScript.bind(baseDriver),
      close: baseDriver.close.bind(baseDriver),
      transaction: async <T>(cb: (tx: SqliteTxDriver) => Promise<T> | T): Promise<T> => {
        // Mimic the transaction shape but with a tx that throws
        // on blob writes.
        raw.exec('BEGIN');
        try {
          const tx = {
            execute: async (sql: string, params: readonly unknown[]) => {
              if (sql.includes('INSERT INTO blobs')) {
                throw new Error('simulated blob write failure');
              }
              return baseDriver.execute(sql, params);
            },
            select: <U = Record<string, unknown>>(sql: string, params: readonly unknown[]) =>
              baseDriver.select<U>(sql, params),
          };
          await cb(tx);
          raw.exec('COMMIT');
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        }
        return undefined as T;
      },
    };
    const storage = TauriSqliteStorage.fromDriver(saboteur);

    const id = PostId('post_atomic04');
    const blobId = ImageBlobId('blob_atomic04');
    const post = createDraftPost({ id });
    post.imageBlobId = blobId;
    // Force state for test — see comment above.
    post.state = 'image_ready';
    const blob = makeBlob(id, blobId);

    await expect(storage.savePostWithBlob(post, blob)).rejects.toThrow(
      'simulated blob write failure'
    );

    // Neither the post nor the blob should be visible.
    expect(await storage.getPost(id)).toBeNull();
    expect(await storage.getBlob(blobId)).toBeNull();

    baseDriver.close();
  });
});

describeSqlite('TauriSqliteStorage: round-trip and queries', () => {
  it('preserves all PostRecord fields through write + read', async () => {
    const { storage } = await makeStorage();
    const id = PostId('post_roundtrip');
    let post = createDraftPost({ id, ideaId: 'idea_42' });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready', { note: 'AI done' });
    post.caption = 'Test caption';
    post.hashtags = ['#mashup', '#ai'];

    await storage.savePostWithBlob(post, null);

    const read = await storage.getPost(id);
    expect(read).toEqual(post);
    expect(read!.hashtags).toEqual(['#mashup', '#ai']);
    expect(read!.history).toHaveLength(2);
  });

  it('listPostsByState returns only posts in the requested state', async () => {
    const { storage } = await makeStorage();
    const p1 = createDraftPost({ id: PostId('post_d10001') });
    const p2 = createDraftPost({ id: PostId('post_d20002') });
    const p3 = transition(
      createDraftPost({ id: PostId('post_g10001') }),
      'generating_image'
    );

    await storage.savePostWithBlob(p1, null);
    await storage.savePostWithBlob(p2, null);
    await storage.savePostWithBlob(p3, null);

    const drafts = await storage.listPostsByState('draft');
    expect(drafts.map((p) => p.id).sort()).toEqual([
      PostId('post_d10001'),
      PostId('post_d20002'),
    ]);

    const generating = await storage.listPostsByState('generating_image');
    expect(generating.map((p) => p.id)).toEqual([PostId('post_g10001')]);
  });

  it('listPosts returns every saved post', async () => {
    const { storage } = await makeStorage();
    await storage.savePostWithBlob(
      createDraftPost({ id: PostId('post_l10001') }),
      null
    );
    await storage.savePostWithBlob(
      createDraftPost({ id: PostId('post_l20002') }),
      null
    );

    const all = await storage.listPosts();
    expect(all).toHaveLength(2);
  });
});

describeSqlite('TauriSqliteStorage: cascade delete', () => {
  it('deletePost removes the post and cascades the blob via FK', async () => {
    const { storage } = await makeStorage();
    const id = PostId('post_delete01');
    const blobId = ImageBlobId('blob_delete01');
    const post = createDraftPost({ id });
    post.imageBlobId = blobId;
    // Force state for test — see comment above.
    post.state = 'image_ready';
    const blob = makeBlob(id, blobId);

    await storage.savePostWithBlob(post, blob);
    await storage.deletePost(id);

    expect(await storage.getPost(id)).toBeNull();
    // The FK ON DELETE CASCADE fires inside the same transaction.
    expect(await storage.getBlob(blobId)).toBeNull();
  });

  it('stale blob is dropped when post moves to a state with no image', async () => {
    const { storage } = await makeStorage();
    const id = PostId('post_stale01');
    const blobId = ImageBlobId('blob_stale01');
    let post = createDraftPost({ id });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready');
    post.imageBlobId = blobId;
    const blob = makeBlob(id, blobId);

    await storage.savePostWithBlob(post, blob);

    // Simulate the reconciler moving the post to failed.
    const failed = transition(post, 'failed', {
      reason: 'image_missing',
      note: 'test',
      reconciler: true,
    });
    failed.imageBlobId = null;
    await storage.savePostWithBlob(failed, null);

    expect(await storage.getBlob(blobId)).toBeNull();
    expect((await storage.getPost(id))!.state).toBe('failed');
  });
});

describeSqlite('TauriSqliteStorage: touchBlobVerifiedAt', () => {
  it('updates only the last_verified_at field on the blob', async () => {
    const { storage } = await makeStorage();
    const id = PostId('post_touch001');
    const blobId = ImageBlobId('blob_touch001');
    const post = createDraftPost({ id });
    post.imageBlobId = blobId;
    // Force state for test — see comment above.
    post.state = 'image_ready';
    const blob = makeBlob(id, blobId);
    const originalSize = blob.sizeBytes;
    const originalVerifiedAt = blob.lastVerifiedAt;

    await storage.savePostWithBlob(post, blob);

    await new Promise((r) => setTimeout(r, 10));
    await storage.touchBlobVerifiedAt(blobId);

    const read = await storage.getBlob(blobId);
    expect(read!.lastVerifiedAt).not.toBe(originalVerifiedAt);
    expect(read!.sizeBytes).toBe(originalSize);
  });
});

// ── The v0.9.41 regression gate ─────────────────────────────────────────

describeSqlite('v0.9.41 regression: SQLite storage prevents the bug at write time', () => {
  it('savePostWithBlob rejects a post with imageBlobId but no blob', async () => {
    const { storage } = await makeStorage();
    const postId = PostId('post_v0941_sqlite');
    let post = createDraftPost({ id: postId });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready');
    post = transition(post, 'captioning');
    post = transition(post, 'caption_ready');
    post = transition(post, 'scheduled', { note: 'tomorrow 9am' });
    // The v0.9.41 bug shape: post.imageBlobId is set but no
    // blob is provided. The production backend must reject
    // this at write time — that is the primary defence.
    post.imageBlobId = ImageBlobId('blob_v0941_missing');

    await expect(
      storage.savePostWithBlob(post, null)
    ).rejects.toThrow(AtomicityViolationError);

    // The rejected write left the store untouched.
    expect(await storage.getPost(postId)).toBeNull();
  });
});
