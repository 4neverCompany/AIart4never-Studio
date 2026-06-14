-- Migration 001: post-lifecycle schema
--
-- Creates the `posts` and `blobs` tables that back the
-- PostLifecycleStorage SQLite implementation. The two tables are
-- joined on `posts.image_blob_id = blobs.id` (and `blobs.post_id =
-- posts.id` for the reverse lookup). Atomicity is enforced at the
-- transaction level by `TauriSqliteStorage.savePostWithBlob` (and
-- its test driver counterpart).
--
-- Why this layout:
--   - Posts are small and frequently read. They're the query target.
--   - Blobs are large binary payloads that are read only at post time.
--     Keeping them in a separate table avoids bloating the posts index
--     and lets the schema survive without a hard upper bound on image
--     size.
--   - The `history` column on `posts` is denormalized into a single
--     JSON blob. The state machine's audit trail is append-only and
--     is read in full when a post is loaded, so per-row storage would
--     be over-engineering.
--
-- Indexes:
--   - `idx_posts_state` supports the reconciler's per-state scans
--     (image_ready, scheduled, etc.)
--   - `idx_posts_scheduled` supports the scheduler's "what fires next"
--     query, which is `WHERE state = 'scheduled' AND scheduled_for <= now`.
--     The partial-index clause keeps it small — only scheduled posts
--     are indexed, not the entire posts table.
--
-- Foreign keys:
--   - `blobs.post_id` references `posts.id` with `ON DELETE CASCADE`
--     so `deletePost()` automatically cleans up orphaned blobs without
--     a separate round trip.

CREATE TABLE posts (
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

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  format TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  data BLOB NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX idx_posts_state ON posts(state);
CREATE INDEX idx_posts_scheduled ON posts(scheduled_for) WHERE state = 'scheduled';
CREATE INDEX idx_blobs_post_id ON blobs(post_id);
