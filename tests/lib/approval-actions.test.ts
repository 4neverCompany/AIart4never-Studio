import { describe, it, expect } from 'vitest';
import {
  planApproveScheduledPost,
  planRejectScheduledPost,
} from '@/lib/approval-actions';
import type { ScheduledPost } from '@/types/mashup';

// BUG-CRIT-012 regression gate. The pure helpers below replace the old
// closure-inside-updater pattern in MashupContext that silently dropped
// finalize for the 2nd+ call in a row (carousel approve-all).
// If a future refactor reintroduces the read-inside-updater pattern,
// these tests pin the contract: each call against the same snapshot
// must return its own toFinalize entry. Otherwise carousel siblings
// will go un-watermarked and stay hidden in pipelinePending state.

const mkPost = (overrides: Partial<ScheduledPost> = {}): ScheduledPost => ({
  id: 'p-1',
  imageId: 'img-1',
  date: '2026-04-20',
  time: '09:00',
  platforms: ['instagram'],
  caption: '',
  status: 'pending_approval',
  ...overrides,
});

describe('planApproveScheduledPost', () => {
  it('returns the matching pending_approval post in toFinalize', () => {
    const posts = [mkPost({ id: 'p-1' })];
    const { toFinalize } = planApproveScheduledPost(posts, 'p-1');
    expect(toFinalize).toHaveLength(1);
    expect(toFinalize[0]!.id).toBe('p-1');
  });

  it('skips posts that are not pending_approval (idempotent double-click)', () => {
    expect(
      planApproveScheduledPost([mkPost({ status: 'scheduled' })], 'p-1').toFinalize,
    ).toEqual([]);
    expect(
      planApproveScheduledPost([mkPost({ status: 'rejected' })], 'p-1').toFinalize,
    ).toEqual([]);
    expect(
      planApproveScheduledPost([mkPost({ status: 'posted' })], 'p-1').toFinalize,
    ).toEqual([]);
  });

  it('returns empty toFinalize when the post id is unknown', () => {
    expect(
      planApproveScheduledPost([mkPost({ id: 'p-1' })], 'p-other').toFinalize,
    ).toEqual([]);
  });

  it('flips only the matching pending_approval post to scheduled', () => {
    const posts = [
      mkPost({ id: 'p-1', status: 'pending_approval' }),
      mkPost({ id: 'p-2', status: 'pending_approval' }),
      mkPost({ id: 'p-3', status: 'scheduled' }),
    ];
    const { nextPosts } = planApproveScheduledPost(posts, 'p-1');
    const after = nextPosts(posts);
    expect(after.find((p) => p.id === 'p-1')!.status).toBe('scheduled');
    expect(after.find((p) => p.id === 'p-2')!.status).toBe('pending_approval');
    expect(after.find((p) => p.id === 'p-3')!.status).toBe('scheduled');
  });

  it('nextPosts is idempotent: re-running over already-scheduled state is a no-op', () => {
    const posts = [mkPost({ id: 'p-1', status: 'scheduled' })];
    const { nextPosts } = planApproveScheduledPost(
      [mkPost({ id: 'p-1', status: 'pending_approval' })],
      'p-1',
    );
    expect(nextPosts(posts)).toEqual(posts);
  });
});

describe('planRejectScheduledPost', () => {
  it('returns the matching pending_approval post in toFinalize', () => {
    const posts = [mkPost({ id: 'p-1' })];
    const { toFinalize } = planRejectScheduledPost(posts, 'p-1');
    expect(toFinalize[0]!.id).toBe('p-1');
  });

  it('flips only the matching pending_approval post to rejected', () => {
    const posts = [
      mkPost({ id: 'p-1', status: 'pending_approval' }),
      mkPost({ id: 'p-2', status: 'pending_approval' }),
    ];
    const { nextPosts } = planRejectScheduledPost(posts, 'p-1');
    const after = nextPosts(posts);
    expect(after.find((p) => p.id === 'p-1')!.status).toBe('rejected');
    expect(after.find((p) => p.id === 'p-2')!.status).toBe('pending_approval');
  });

  it('skips already-scheduled / posted / rejected posts (status guard)', () => {
    expect(
      planRejectScheduledPost([mkPost({ status: 'scheduled' })], 'p-1').toFinalize,
    ).toEqual([]);
    expect(
      planRejectScheduledPost([mkPost({ status: 'posted' })], 'p-1').toFinalize,
    ).toEqual([]);
    expect(
      planRejectScheduledPost([mkPost({ status: 'rejected' })], 'p-1').toFinalize,
    ).toEqual([]);
  });
});

describe('BUG-CRIT-012 — carousel approve-all sequential-call invariant', () => {
  // The bug: in MashupContext, the read of approvedPost lived inside
  // the updateSettings functional updater. React only invokes that
  // updater synchronously when its update queue is empty (the eager-
  // state-update optimization). When CarouselApprovalCard fans out 3
  // approveScheduledPost calls in a tight loop, only the FIRST gets
  // the eager-eval — calls 2 and 3 see a non-empty queue, the updater
  // is deferred to the render phase, and the synchronous "if
  // (approvedPost) finalize(...)" fires with approvedPost still
  // undefined. Result: images 2 and 3 stay pipelinePending=true.
  //
  // The fix: read against the rendered settings snapshot OUTSIDE
  // updateSettings. This test pins the invariant by simulating exactly
  // that rendered-snapshot pattern — three sequential calls against
  // one snapshot must each produce a finalize target.

  it('three sequential calls against one snapshot all return their finalize targets (approve)', () => {
    const snapshot = [
      mkPost({ id: 'p-1', imageId: 'img-1', carouselGroupId: 'g1' }),
      mkPost({ id: 'p-2', imageId: 'img-2', carouselGroupId: 'g1' }),
      mkPost({ id: 'p-3', imageId: 'img-3', carouselGroupId: 'g1' }),
    ];
    const r1 = planApproveScheduledPost(snapshot, 'p-1');
    const r2 = planApproveScheduledPost(snapshot, 'p-2');
    const r3 = planApproveScheduledPost(snapshot, 'p-3');

    expect(r1.toFinalize.map((p) => p.id)).toEqual(['p-1']);
    expect(r2.toFinalize.map((p) => p.id)).toEqual(['p-2']);
    expect(r3.toFinalize.map((p) => p.id)).toEqual(['p-3']);
  });

  it('three sequential calls against one snapshot all return their finalize targets (reject)', () => {
    const snapshot = [
      mkPost({ id: 'p-1', imageId: 'img-1', carouselGroupId: 'g1' }),
      mkPost({ id: 'p-2', imageId: 'img-2', carouselGroupId: 'g1' }),
      mkPost({ id: 'p-3', imageId: 'img-3', carouselGroupId: 'g1' }),
    ];
    const r1 = planRejectScheduledPost(snapshot, 'p-1');
    const r2 = planRejectScheduledPost(snapshot, 'p-2');
    const r3 = planRejectScheduledPost(snapshot, 'p-3');

    expect(r1.toFinalize.map((p) => p.id)).toEqual(['p-1']);
    expect(r2.toFinalize.map((p) => p.id)).toEqual(['p-2']);
    expect(r3.toFinalize.map((p) => p.id)).toEqual(['p-3']);
  });

  it('chained nextPosts updaters compose correctly when applied left-to-right (matches React queue order)', () => {
    // React processes queued functional updaters in order, each
    // receiving the previous updater's output. This pins that our
    // helper's nextPosts plays nicely with that — three approves in a
    // row land all three siblings as 'scheduled'.
    const initial = [
      mkPost({ id: 'p-1', status: 'pending_approval' }),
      mkPost({ id: 'p-2', status: 'pending_approval' }),
      mkPost({ id: 'p-3', status: 'pending_approval' }),
    ];
    const r1 = planApproveScheduledPost(initial, 'p-1');
    const r2 = planApproveScheduledPost(initial, 'p-2');
    const r3 = planApproveScheduledPost(initial, 'p-3');

    const after = r3.nextPosts(r2.nextPosts(r1.nextPosts(initial)));
    expect(after.map((p) => p.status)).toEqual([
      'scheduled',
      'scheduled',
      'scheduled',
    ]);
  });
});
