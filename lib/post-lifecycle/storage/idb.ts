/**
 * IndexedDB storage backend for the post-lifecycle state machine.
 *
 * The web surface (Next.js / PWA) uses this implementation. It is
 * the production target for browsers.
 *
 * ATOMICITY:
 *   `savePostWithBlob` writes the post metadata and the image blob
 *   in a single `readwrite` transaction that spans both object stores.
 *   IndexedDB guarantees that the transaction either commits both
 *   writes or commits neither. There is no observable state where
 *   the post is visible but the blob is not.
 *
 * WHY NOT idb-keyval?
 *   `idb-keyval` is a single-store key/value layer. It does not
 *   expose the underlying IndexedDB transaction, so it cannot
 *   guarantee atomic multi-store writes. We use `idb` (the lower-
 *   level wrapper) directly here, and keep `idb-keyval` for the
 *   pre-existing BUG-DEV-012 fallback path in `lib/persistence.ts`.
 *
 * SCHEMA:
 *   Database: `mashupforge-post-lifecycle` v1
 *   - posts   (keyPath: 'id', value: PostRecord-as-plain-object)
 *   - blobs   (keyPath: 'id', value: ImageBlob-as-plain-object,
 *             index: 'post_id' for orphan-blob cleanup)
 *
 * The "as plain object" is important: the in-memory `PostRecord` and
 * `ImageBlob` use branded types and readonly fields, but IndexedDB
 * cannot structured-clone branded type tags or readonly fields
 * meaningfully. The converters strip/attach the brand on the
 * boundary; the storage layer deals in plain serialisable shapes.
 */

import {
  openDB,
  type IDBPDatabase,
  type DBSchema,
  type IDBPTransaction,
  type StoreNames,
} from 'idb';

import {
  type PostRecord,
  type PostState,
  type ImageBlob,
  type PostId,
  type ImageBlobId,
  AtomicityViolationError,
} from '../types';
import type { PostLifecycleStorage } from '../persistence';

const DB_NAME = 'mashupforge-post-lifecycle';
const DB_VERSION = 1;
const POSTS_STORE = 'posts';
const BLOBS_STORE = 'blobs';

interface PostLifecycleDb extends DBSchema {
  posts: {
    key: string;
    value: SerialisedPost;
    indexes: { state: string };
  };
  blobs: {
    key: string;
    value: SerialisedBlob;
    indexes: { post_id: string };
  };
}

// ── Serialisation ────────────────────────────────────────────────────────
//
// The runtime representation in `types.ts` uses branded primitives
// (e.g. `PostId`, `ImageBlobId`) which are structurally just strings.
// IndexedDB's structured-clone algorithm clones the value without
// preserving TypeScript's brand, so the round-trip is structurally
// identical. We still cast through these types at the boundary so
// the rest of the module can keep its type safety.

interface SerialisedPost {
  id: string;
  state: PostState;
  imageBlobId: string | null;
  hostedImageUrl: string | null;
  caption: string | null;
  hashtags: string[];
  scheduledFor: string | null;
  platform: PostRecord['platform'];
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  failureReason: PostRecord['failureReason'];
  failureContext: Record<string, unknown> | null;
  retryCount: number;
  retryable: boolean;
  nextRetryAt: string | null;
  history: PostRecord['history'];
  ideaId: string | null;
  imageModelId: string | null;
}

interface SerialisedBlob {
  id: string;
  postId: string;
  format: ImageBlob['format'];
  sizeBytes: number;
  createdAt: string;
  lastVerifiedAt: string;
  data: ArrayBuffer;
}

function postToStored(post: PostRecord): SerialisedPost {
  return {
    id: post.id,
    state: post.state,
    imageBlobId: post.imageBlobId,
    hostedImageUrl: post.hostedImageUrl,
    caption: post.caption,
    hashtags: [...post.hashtags],
    scheduledFor: post.scheduledFor,
    platform: post.platform,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    stateChangedAt: post.stateChangedAt,
    failureReason: post.failureReason,
    failureContext: post.failureContext ? { ...post.failureContext } : null,
    retryCount: post.retryCount,
    retryable: post.retryable,
    nextRetryAt: post.nextRetryAt,
    history: post.history.map((h) => ({ ...h })),
    ideaId: post.ideaId,
    imageModelId: post.imageModelId,
  };
}

function postFromStored(stored: SerialisedPost): PostRecord {
  return {
    id: stored.id as PostRecord['id'],
    state: stored.state,
    imageBlobId: stored.imageBlobId as PostRecord['imageBlobId'],
    hostedImageUrl: stored.hostedImageUrl,
    caption: stored.caption,
    hashtags: stored.hashtags,
    scheduledFor: stored.scheduledFor,
    platform: stored.platform,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    stateChangedAt: stored.stateChangedAt,
    failureReason: stored.failureReason,
    failureContext: stored.failureContext,
    retryCount: stored.retryCount,
    retryable: stored.retryable,
    nextRetryAt: stored.nextRetryAt,
    history: stored.history,
    ideaId: stored.ideaId,
    imageModelId: stored.imageModelId,
  };
}

function blobToStored(blob: ImageBlob): SerialisedBlob {
  return {
    id: blob.id,
    postId: blob.postId,
    format: blob.format,
    sizeBytes: blob.sizeBytes,
    createdAt: blob.createdAt,
    lastVerifiedAt: blob.lastVerifiedAt,
    data: blob.data,
  };
}

function blobFromStored(stored: SerialisedBlob): ImageBlob {
  return {
    id: stored.id as ImageBlob['id'],
    postId: stored.postId as ImageBlob['postId'],
    format: stored.format,
    sizeBytes: stored.sizeBytes,
    createdAt: stored.createdAt,
    lastVerifiedAt: stored.lastVerifiedAt,
    data: stored.data,
  };
}

// ── Driver ───────────────────────────────────────────────────────────────
//
// We split the driver from the storage so the test suite can pass in
// a fake `IDBPDatabase`-shaped factory. This mirrors the
// `SqliteDriver` pattern in `tauri-sqlite.ts`. Production callers
// use `IdbPostLifecycleStorage.open()`; tests use the
// `IdbPostLifecycleStorage.withDatabase(db)` factory.

export interface IdbDriver {
  /**
   * Run a function inside a `readwrite` transaction that spans
   * both `posts` and `blobs` stores. The function is responsible
   * for the actual `put`/`delete` calls; the transaction wrapper
   * only handles scope and commit/abort semantics.
   *
   * If the callback throws, the transaction is aborted and the
   * error propagates. If it returns normally, the transaction
   * commits.
   */
  runWriteTransaction<T>(
    scope: readonly ['posts', 'blobs'],
    callback: (tx: IdbWriteTx) => Promise<T> | T
  ): Promise<T>;

  /**
   * Read from the `posts` store by id. Returns `null` if missing.
   */
  getPost(id: string): Promise<SerialisedPost | null>;

  /**
   * Read from the `blobs` store by id. Returns `null` if missing.
   */
  getBlob(id: string): Promise<SerialisedBlob | null>;

  /**
   * Read all posts, optionally filtered by state. Used by the
   * reconciler's full scan.
   */
  getAllPosts(state?: PostState): Promise<SerialisedPost[]>;

  /**
   * Update only the `last_verified_at` field on a blob. No
   * transaction needed (single-key single-field write).
   */
  updateBlobVerifiedAt(id: string, at: string): Promise<void>;

  /**
   * Close the underlying connection. Idempotent.
   */
  close(): void;
}

/**
 * A read/write transaction handle for both stores. Implementations
 * must guarantee that `put` and `delete` calls resolve only after
 * the transaction commits; in practice this is enforced by the
 * underlying IndexedDB transaction.
 */
export interface IdbWriteTx {
  putPost(post: SerialisedPost): void;
  putBlob(blob: SerialisedBlob): void;
  deletePost(id: string): void;
  deleteBlob(id: string): void;
}

// ── idb-backed driver (production) ───────────────────────────────────────

async function openIdbDatabase(name: string = DB_NAME): Promise<IDBPDatabase<PostLifecycleDb>> {
  return openDB<PostLifecycleDb>(name, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(POSTS_STORE)) {
        const posts = db.createObjectStore(POSTS_STORE, { keyPath: 'id' });
        posts.createIndex('state', 'state', { unique: false });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        const blobs = db.createObjectStore(BLOBS_STORE, { keyPath: 'id' });
        blobs.createIndex('post_id', 'postId', { unique: false });
      }
    },
  });
}

class IdbLibraryDriver implements IdbDriver {
  constructor(private readonly db: IDBPDatabase<PostLifecycleDb>) {}

  async runWriteTransaction<T>(
    _scope: readonly ['posts', 'blobs'],
    callback: (tx: IdbWriteTx) => Promise<T> | T
  ): Promise<T> {
    // The `idb` library exposes transactions through its own object
    // wrapper, not a raw IDBPTransaction. We adapt to our minimal
    // IdbWriteTx surface so the storage class doesn't need to know
    // about the underlying library.
    const stores: readonly [StoreNames<PostLifecycleDb>, StoreNames<PostLifecycleDb>] = [
      POSTS_STORE,
      BLOBS_STORE,
    ];
    const tx = await this.db.transaction(stores, 'readwrite');
    const adapter: IdbWriteTx = {
      putPost: (post) => {
        void tx.objectStore(POSTS_STORE).put(post);
      },
      putBlob: (blob) => {
        void tx.objectStore(BLOBS_STORE).put(blob);
      },
      deletePost: (id) => {
        void tx.objectStore(POSTS_STORE).delete(id);
      },
      deleteBlob: (id) => {
        void tx.objectStore(BLOBS_STORE).delete(id);
      },
    };
    const result = await callback(adapter);
    await tx.done;
    return result;
  }

  async getPost(id: string): Promise<SerialisedPost | null> {
    const result = await this.db.get(POSTS_STORE, id);
    return result ?? null;
  }

  async getBlob(id: string): Promise<SerialisedBlob | null> {
    const result = await this.db.get(BLOBS_STORE, id);
    return result ?? null;
  }

  async getAllPosts(state?: PostState): Promise<SerialisedPost[]> {
    if (state === undefined) {
      return (await this.db.getAll(POSTS_STORE)) as SerialisedPost[];
    }
    return (await this.db.getAllFromIndex(
      POSTS_STORE,
      'state',
      state
    )) as SerialisedPost[];
  }

  async updateBlobVerifiedAt(id: string, at: string): Promise<void> {
    const existing = await this.db.get(BLOBS_STORE, id);
    if (!existing) return;
    existing.lastVerifiedAt = at;
    await this.db.put(BLOBS_STORE, existing);
  }

  close(): void {
    this.db.close();
  }
}

// ── The storage class ────────────────────────────────────────────────────

/**
 * The IndexedDB-backed `PostLifecycleStorage` implementation.
 *
 * Construct via:
 *   - `IdbPostLifecycleStorage.open()` for production web usage
 *   - `IdbPostLifecycleStorage.withDatabase(idbDb)` for tests that
 *     bring their own `IDBPDatabase` (e.g. fake-indexeddb)
 *   - `IdbPostLifecycleStorage.withDriver(customDriver)` for tests
 *     that want to verify the storage layer in isolation
 */
export class IdbPostLifecycleStorage implements PostLifecycleStorage {
  private constructor(private readonly driver: IdbDriver) {}

  static async open(name: string = DB_NAME): Promise<IdbPostLifecycleStorage> {
    const db = await openIdbDatabase(name);
    return new IdbPostLifecycleStorage(new IdbLibraryDriver(db));
  }

  static withDatabase(db: IDBPDatabase<PostLifecycleDb>): IdbPostLifecycleStorage {
    return new IdbPostLifecycleStorage(new IdbLibraryDriver(db));
  }

  static withDriver(driver: IdbDriver): IdbPostLifecycleStorage {
    return new IdbPostLifecycleStorage(driver);
  }

  async savePostWithBlob(post: PostRecord, blob: ImageBlob | null): Promise<void> {
    // Pre-flight consistency checks. These mirror the InMemoryStorage
    // invariants. We enforce them at the storage boundary so the
    // reconciliation invariants hold for callers that bypass the
    // state machine.
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

    const storedPost = postToStored(post);
    const storedBlob = blob ? blobToStored(blob) : null;

    // The atomic write spans both stores. If the callback throws
    // (or the transaction aborts), neither write is visible to
    // subsequent reads. This is the v0.9.41 atomicity contract.
    //
    // We also delete any previously-stored blob for this post if
    // the new save is dropping the image (e.g. transitioning out
    // of `image_ready` to `failed` and the reconciler is recording
    // the failure). The delete is part of the same transaction,
    // so it commits or aborts with the post write.
    const previousBlobId = await this.driver.getPost(post.id);
    const oldBlobId = previousBlobId?.imageBlobId ?? null;

    await this.driver.runWriteTransaction(
      [POSTS_STORE, BLOBS_STORE],
      (tx) => {
        tx.putPost(storedPost);
        if (storedBlob) {
          tx.putBlob(storedBlob);
        } else if (oldBlobId && oldBlobId !== post.imageBlobId) {
          // The post is moving to a state that no longer references
          // an image (e.g. failed, draft). Drop the stale blob in
          // the same transaction.
          tx.deleteBlob(oldBlobId);
        }
      }
    );
  }

  async getPost(id: PostId): Promise<PostRecord | null> {
    const stored = await this.driver.getPost(id);
    return stored ? postFromStored(stored) : null;
  }

  async getBlob(id: ImageBlobId): Promise<ImageBlob | null> {
    const stored = await this.driver.getBlob(id);
    return stored ? blobFromStored(stored) : null;
  }

  async listPosts(): Promise<PostRecord[]> {
    const stored = await this.driver.getAllPosts();
    return stored.map(postFromStored);
  }

  async listPostsByState(state: PostState): Promise<PostRecord[]> {
    const stored = await this.driver.getAllPosts(state);
    return stored.map(postFromStored);
  }

  async deletePost(id: PostId): Promise<void> {
    // Cascade-blob delete is part of the same transaction so we
    // can't leave an orphan blob behind on partial failure.
    const existing = await this.driver.getPost(id);
    if (!existing) return;
    const blobIdToDelete = existing.imageBlobId;

    await this.driver.runWriteTransaction(
      [POSTS_STORE, BLOBS_STORE],
      (tx) => {
        tx.deletePost(id);
        if (blobIdToDelete) {
          tx.deleteBlob(blobIdToDelete);
        }
      }
    );
  }

  async touchBlobVerifiedAt(id: ImageBlobId): Promise<void> {
    await this.driver.updateBlobVerifiedAt(id, new Date().toISOString());
  }
}
