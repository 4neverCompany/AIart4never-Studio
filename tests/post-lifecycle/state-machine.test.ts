/**
 * State machine unit tests.
 *
 * Covers:
 *   - All valid transitions succeed
 *   - All invalid transitions throw InvalidTransitionError
 *   - Failed transitions record a reason
 *   - History is append-only
 *   - Retry policy is correctly applied
 */

import { describe, it, expect } from 'vitest';
import {
  PostId,
  ImageBlobId,
  transition,
  canTransition,
  createDraftPost,
  isRetryable,
  isExhausted,
  nextRetryDelay,
  InvalidTransitionError,
} from '@/lib/post-lifecycle';

describe('state machine: valid transitions', () => {
  const id = PostId('post_abcdef');
  const draft = createDraftPost({ id });

  it('draft → generating_image', () => {
    const next = transition(draft, 'generating_image');
    expect(next.state).toBe('generating_image');
    expect(next.history).toHaveLength(1);
    expect(next.history[0]).toMatchObject({ from: 'draft', to: 'generating_image' });
  });

  it('full happy path: draft → ... → posted', () => {
    let post = createDraftPost({ id });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready', { note: 'AI image generated' });
    post = transition(post, 'captioning');
    post = transition(post, 'caption_ready', { note: 'AI caption generated' });
    post = transition(post, 'scheduled', { note: 'User scheduled for tomorrow 9am' });
    post = transition(post, 'posting');
    post = transition(post, 'posted', { note: 'Instagram post id 12345' });

    expect(post.state).toBe('posted');
    // 7 transitions: draft → generating_image → image_ready →
    // captioning → caption_ready → scheduled → posting → posted
    expect(post.history).toHaveLength(7);
    expect(post.failureReason).toBeNull();
  });

  it('failed → draft (user-initiated restart)', () => {
    let post = createDraftPost({ id });
    post = transition(post, 'generating_image');
    post = transition(post, 'failed', { reason: 'image_generation_failed', note: 'rate limit' });
    expect(post.state).toBe('failed');
    expect(post.failureReason).toBe('image_generation_failed');
    expect(post.retryCount).toBe(1);

    post = transition(post, 'draft');
    expect(post.state).toBe('draft');
    expect(post.retryCount).toBe(0); // reset on successful transition
  });
});

describe('state machine: invalid transitions', () => {
  it('draft → posted is invalid', () => {
    const draft = createDraftPost({ id: PostId('post_abcdef') });
    expect(() => transition(draft, 'posted')).toThrow(InvalidTransitionError);
  });

  it('posted → anything is invalid (terminal)', () => {
    let post = createDraftPost({ id: PostId('post_abcdef') });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready');
    post = transition(post, 'captioning');
    post = transition(post, 'caption_ready');
    post = transition(post, 'scheduled');
    post = transition(post, 'posting');
    post = transition(post, 'posted');

    expect(() => transition(post, 'failed')).toThrow(InvalidTransitionError);
    expect(() => transition(post, 'draft')).toThrow(InvalidTransitionError);
  });

  it('image_ready → posting is invalid (must go through captioning/scheduled)', () => {
    let post = createDraftPost({ id: PostId('post_abcdef') });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready');
    expect(() => transition(post, 'posting')).toThrow(InvalidTransitionError);
  });

  it('transitioning to failed without a reason throws', () => {
    // First get the post into a state that allows a transition
    // to `failed` (e.g. `generating_image`). The state machine
    // checks validity before checking for the reason, so we
    // can't trigger the "requires a reason" error from `draft`.
    const draft = createDraftPost({ id: PostId('post_abcdef') });
    const generating = transition(draft, 'generating_image');
    expect(() => transition(generating, 'failed')).toThrow(/requires a reason/);
  });
});

describe('state machine: history is append-only', () => {
  it('history grows with each transition', () => {
    let post = createDraftPost({ id: PostId('post_abcdef') });
    expect(post.history).toHaveLength(0);

    post = transition(post, 'generating_image');
    expect(post.history).toHaveLength(1);

    post = transition(post, 'failed', { reason: 'image_generation_failed' });
    expect(post.history).toHaveLength(2);
    expect(post.history[1].reason).toBe('image_generation_failed');
  });

  it('history entries are immutable (frozen-style via readonly)', () => {
    const draft = createDraftPost({ id: PostId('post_abcdef') });
    const post = transition(draft, 'generating_image');
    // The state machine never mutates the post. The caller gets a
    // new PostRecord each time. So the history of the original draft
    // is not modified.
    expect(draft.history).toHaveLength(0);
    expect(post.history).toHaveLength(1);
  });
});

describe('state machine: retry policy', () => {
  it('image_missing is not auto-retryable', () => {
    expect(isRetryable('image_missing')).toBe(false);
  });

  it('image_upload_failed is auto-retryable', () => {
    expect(isRetryable('image_upload_failed')).toBe(true);
  });

  it('caption_blocked is not auto-retryable (requires user action)', () => {
    expect(isRetryable('caption_blocked')).toBe(false);
  });

  it('exhausted: after max retries, give up', () => {
    expect(isExhausted('image_upload_failed', 3)).toBe(true);
    expect(isExhausted('image_upload_failed', 2)).toBe(false);
  });

  it('backoff: doubles each attempt, capped at 1 hour', () => {
    expect(nextRetryDelay('image_upload_failed', 0)).toBe(5 * 60 * 1000);
    expect(nextRetryDelay('image_upload_failed', 1)).toBe(10 * 60 * 1000);
    expect(nextRetryDelay('image_upload_failed', 2)).toBe(20 * 60 * 1000);
    // Capped
    expect(nextRetryDelay('image_upload_failed', 20)).toBe(60 * 60 * 1000);
  });
});

describe('canTransition', () => {
  it('returns true for valid transitions', () => {
    expect(canTransition('draft', 'generating_image')).toBe(true);
    expect(canTransition('scheduled', 'posting')).toBe(true);
  });

  it('returns false for invalid transitions', () => {
    expect(canTransition('draft', 'posted')).toBe(false);
    expect(canTransition('posted', 'failed')).toBe(false);
  });

  it('reconciler flag allows scheduled → image_ready re-promote', () => {
    expect(canTransition('scheduled', 'image_ready')).toBe(false);
    expect(canTransition('scheduled', 'image_ready', { reconciler: true })).toBe(true);
  });
});
