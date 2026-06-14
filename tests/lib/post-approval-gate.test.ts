import { describe, it, expect } from 'vitest';
import {
  findPostingBlock,
  isStillScheduled,
} from '@/lib/post-approval-gate';
import type { ScheduledPost } from '@/types/mashup';

// BUG-CRIT-011 regression gate. Both the auto-poster snapshot loop and
// the manual Post Now buttons funnel through this module to enforce the
// approval queue. If a 'rejected' or 'pending_approval' post ever slips
// past, content the user explicitly disapproved goes live on Instagram.

const makePost = (overrides: Partial<ScheduledPost>): ScheduledPost => ({
  id: 'p-1',
  imageId: 'img-1',
  date: '2026-04-20',
  time: '09:00',
  platforms: ['instagram'],
  caption: '',
  status: 'scheduled',
  ...overrides,
});

describe('findPostingBlock', () => {
  it('returns null when there are no scheduled posts', () => {
    expect(findPostingBlock(['img-1'], undefined)).toBeNull();
    expect(findPostingBlock(['img-1'], [])).toBeNull();
  });

  it('returns null when no scheduled post matches the image id', () => {
    const posts = [makePost({ imageId: 'img-other', status: 'rejected' })];
    expect(findPostingBlock(['img-1'], posts)).toBeNull();
  });

  it('blocks when the matching post is rejected', () => {
    const posts = [makePost({ id: 'p-1', imageId: 'img-1', status: 'rejected' })];
    const block = findPostingBlock(['img-1'], posts);
    expect(block).not.toBeNull();
    expect(block?.reason).toBe('rejected');
    expect(block?.postId).toBe('p-1');
    expect(block?.message).toMatch(/rejected/i);
  });

  it('blocks when the matching post is pending_approval', () => {
    const posts = [makePost({ id: 'p-2', imageId: 'img-1', status: 'pending_approval' })];
    const block = findPostingBlock(['img-1'], posts);
    expect(block?.reason).toBe('pending_approval');
    expect(block?.postId).toBe('p-2');
    expect(block?.message).toMatch(/awaiting approval/i);
  });

  it('does not block scheduled, posted, or failed status', () => {
    expect(findPostingBlock(['img-1'], [makePost({ status: 'scheduled' })])).toBeNull();
    expect(findPostingBlock(['img-1'], [makePost({ status: 'posted' })])).toBeNull();
    expect(findPostingBlock(['img-1'], [makePost({ status: 'failed' })])).toBeNull();
  });

  it('does not block when status is undefined (legacy user-scheduled posts)', () => {
    const posts = [makePost({ status: undefined })];
    expect(findPostingBlock(['img-1'], posts)).toBeNull();
  });

  it('blocks the whole carousel if any sibling image is rejected', () => {
    const posts = [
      makePost({ id: 'p-a', imageId: 'img-a', status: 'scheduled' }),
      makePost({ id: 'p-b', imageId: 'img-b', status: 'rejected' }),
      makePost({ id: 'p-c', imageId: 'img-c', status: 'scheduled' }),
    ];
    const block = findPostingBlock(['img-a', 'img-b', 'img-c'], posts);
    expect(block?.reason).toBe('rejected');
    expect(block?.postId).toBe('p-b');
  });

  it('blocks the whole carousel if any sibling is pending_approval', () => {
    const posts = [
      makePost({ id: 'p-a', imageId: 'img-a', status: 'scheduled' }),
      makePost({ id: 'p-b', imageId: 'img-b', status: 'pending_approval' }),
    ];
    const block = findPostingBlock(['img-a', 'img-b'], posts);
    expect(block?.reason).toBe('pending_approval');
  });

  it('returns the first block encountered (rejection wins over later matches)', () => {
    const posts = [
      makePost({ id: 'p-a', imageId: 'img-1', status: 'rejected' }),
      makePost({ id: 'p-b', imageId: 'img-1', status: 'pending_approval' }),
    ];
    const block = findPostingBlock(['img-1'], posts);
    expect(block?.postId).toBe('p-a');
  });
});

describe('isStillScheduled', () => {
  it('returns false when liveScheduledPosts is undefined', () => {
    expect(isStillScheduled('p-1', undefined)).toBe(false);
  });

  it('returns false when the post id is not present (e.g. user deleted it)', () => {
    expect(isStillScheduled('p-missing', [makePost({ id: 'p-1' })])).toBe(false);
  });

  it('returns true only when the live post status is exactly scheduled', () => {
    expect(
      isStillScheduled('p-1', [makePost({ id: 'p-1', status: 'scheduled' })]),
    ).toBe(true);
  });

  it('returns false when the live post has been rejected mid-loop', () => {
    expect(
      isStillScheduled('p-1', [makePost({ id: 'p-1', status: 'rejected' })]),
    ).toBe(false);
  });

  it('returns false for pending_approval, posted, failed, or undefined', () => {
    expect(
      isStillScheduled('p-1', [makePost({ id: 'p-1', status: 'pending_approval' })]),
    ).toBe(false);
    expect(
      isStillScheduled('p-1', [makePost({ id: 'p-1', status: 'posted' })]),
    ).toBe(false);
    expect(
      isStillScheduled('p-1', [makePost({ id: 'p-1', status: 'failed' })]),
    ).toBe(false);
    expect(
      isStillScheduled('p-1', [makePost({ id: 'p-1', status: undefined })]),
    ).toBe(false);
  });
});
