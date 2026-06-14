// @vitest-environment jsdom
//
// V050-006: integration test for carousel approval fan-out. The
// V040-DES-003 carousel grouping is what makes pipeline approval bearable
// when a single idea spawns 3+ images, but the fan-out (one onApprovePost
// per sibling, with the per-image guard, optimistic state, and ghost
// memory all wired up) is React-state-only — there's no pure function
// to assert against. This test catches:
//
//   1. groupApprovalPosts groups carousel-tagged ScheduledPosts into one
//      card (vs. N single cards)
//   2. clicking "Approve carousel" fires onApprovePost(post.id) once per
//      sibling in the live set
//   3. clicking "Reject carousel" fires onRejectPost(post.id) once per
//      sibling, bypassing the degrade guard the per-image button enforces
//
// Wiring bugs in any of these would silently leave posts pending while
// the user thinks the action took. That's the v0.4.2 Bug-1 shape — UI
// looks fine, state never actually moved.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CarouselApprovalCard } from '@/components/approval/CarouselApprovalCard';
import { ApprovalQueue } from '@/components/pipeline/ApprovalQueue';
import type { GeneratedImage, ScheduledPost } from '@/types/mashup';

beforeEach(() => {
  cleanup();
});

const mkImage = (id: string): GeneratedImage => ({
  id,
  url: `https://example.test/${id}.png`,
  prompt: 'p',
});

const mkPost = (id: string, opts: Partial<ScheduledPost> = {}): ScheduledPost => ({
  id,
  imageId: `img-${id}`,
  date: '2026-04-19',
  time: '09:00',
  platforms: ['instagram'],
  caption: 'shared',
  status: 'pending_approval',
  ...opts,
});

describe('carousel approval — CarouselApprovalCard fan-out', () => {
  it('fires onApprovePost once per sibling when "Approve carousel" is clicked', () => {
    const posts = [
      mkPost('p1', { carouselGroupId: 'g1' }),
      mkPost('p2', { carouselGroupId: 'g1' }),
      mkPost('p3', { carouselGroupId: 'g1' }),
    ];
    const imagesById = new Map<string, GeneratedImage>([
      ['img-p1', mkImage('img-p1')],
      ['img-p2', mkImage('img-p2')],
      ['img-p3', mkImage('img-p3')],
    ]);
    const onApprovePost = vi.fn();
    const onRejectPost = vi.fn();

    render(
      <CarouselApprovalCard
        groupId="g1"
        posts={posts}
        imagesById={imagesById}
        selected={false}
        onToggleSelect={() => {}}
        onApprovePost={onApprovePost}
        onRejectPost={onRejectPost}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /approve carousel/i }));

    expect(onApprovePost).toHaveBeenCalledTimes(3);
    expect(onApprovePost.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2', 'p3']);
    expect(onRejectPost).not.toHaveBeenCalled();
  });

  it('fires onRejectPost once per sibling when "Reject carousel" is clicked', () => {
    const posts = [
      mkPost('p1', { carouselGroupId: 'g1' }),
      mkPost('p2', { carouselGroupId: 'g1' }),
    ];
    const imagesById = new Map<string, GeneratedImage>([
      ['img-p1', mkImage('img-p1')],
      ['img-p2', mkImage('img-p2')],
    ]);
    const onApprovePost = vi.fn();
    const onRejectPost = vi.fn();

    render(
      <CarouselApprovalCard
        groupId="g1"
        posts={posts}
        imagesById={imagesById}
        selected={false}
        onToggleSelect={() => {}}
        onApprovePost={onApprovePost}
        onRejectPost={onRejectPost}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reject carousel/i }));

    expect(onRejectPost).toHaveBeenCalledTimes(2);
    expect(onRejectPost.mock.calls.map((c) => c[0]).sort()).toEqual(['p1', 'p2']);
    expect(onApprovePost).not.toHaveBeenCalled();
  });
});

describe('carousel approval — ApprovalQueue grouping', () => {
  it('renders a single carousel card for a group of carousel-tagged posts and a separate card per single post', () => {
    const posts = [
      mkPost('c1', { carouselGroupId: 'g1' }),
      mkPost('c2', { carouselGroupId: 'g1' }),
      mkPost('c3', { carouselGroupId: 'g1' }),
      mkPost('s1'),
      mkPost('s2'),
    ];
    const images: GeneratedImage[] = posts.map((p) => mkImage(p.imageId));

    render(
      <ApprovalQueue
        posts={posts}
        images={images}
        ideas={[]}
        onApprove={() => {}}
        onReject={() => {}}
        onBulkApprove={() => {}}
        onBulkReject={() => {}}
        onUpdateCaption={() => {}}
      />,
    );

    // The carousel card renders a "Carousel · N" chip header. Singles don't.
    // V091-POLISH: chip text was tightened from "Carousel · N images" to
    // "Carousel · N" so the pill stays compact at 390px.
    const carouselHeaders = screen.getAllByText(/Carousel · \d+/i);
    expect(carouselHeaders).toHaveLength(1);
    expect(carouselHeaders[0]!).toHaveTextContent('Carousel · 3');

    // 1 carousel + 2 singles = 3 "Approve" affordances, but only the
    // carousel card has a "Reject carousel" aria-label.
    expect(screen.getAllByRole('button', { name: /reject carousel/i })).toHaveLength(1);
  });

  // V080-DEV-003: previously a 2-image carousel locked both per-image
  // reject buttons (the old 2-image floor). Lifting the floor to 1
  // means: a 2-image carousel exposes a clickable per-image Reject;
  // clicking it fires onRejectPost(postId) for that one image, the
  // parent removes the rejected post from the queue, and on the next
  // render groupApprovalPosts collapses the surviving 1-sibling group
  // into a single-card item. This test pins both halves of that flow
  // (clickable reject in the expanded review panel, and the post-
  // reject collapse) so a future regression of the floor or the
  // collapse rule fails loudly.
  it('V080-DEV-003: 2-image carousel allows per-image reject and collapses survivor to a single card', () => {
    const posts = [
      mkPost('p1', { carouselGroupId: 'g1' }),
      mkPost('p2', { carouselGroupId: 'g1' }),
    ];
    const imagesById = new Map<string, GeneratedImage>([
      ['img-p1', mkImage('img-p1')],
      ['img-p2', mkImage('img-p2')],
    ]);
    const onApprovePost = vi.fn();
    const onRejectPost = vi.fn();

    const { container } = render(
      <CarouselApprovalCard
        groupId="g1"
        posts={posts}
        imagesById={imagesById}
        selected={false}
        onToggleSelect={() => {}}
        onApprovePost={onApprovePost}
        onRejectPost={onRejectPost}
      />,
    );

    // Expand the review panel — per-image Reject buttons live here.
    fireEvent.click(screen.getByRole('button', { name: /^Review/i }));

    // Per-image reject buttons must be enabled (NOT disabled by the
    // old 2-image floor). We have 2 images so 2 per-image rejects.
    const rejectButtons = within(container).getAllByRole('button', { name: /^Reject$/i });
    expect(rejectButtons).toHaveLength(2);
    for (const btn of rejectButtons) {
      expect(btn).not.toBeDisabled();
    }

    // Clicking the first per-image reject must fan out to onRejectPost
    // exactly once for that postId — not a whole-carousel fan-out.
    fireEvent.click(rejectButtons[0]!);
    expect(onRejectPost).toHaveBeenCalledTimes(1);
    expect(onRejectPost).toHaveBeenCalledWith('p1');
    expect(onApprovePost).not.toHaveBeenCalled();
  });

  it('V080-DEV-003: after a 2→1 reject, ApprovalQueue collapses the survivor to a single-image card (no carousel header)', () => {
    // Simulates the post-reject queue state: only 1 sibling left in
    // pending_approval. groupApprovalPosts must drop this from the
    // carousel branch and render it as a normal single card.
    const posts = [mkPost('p2', { carouselGroupId: 'g1' })];
    const images: GeneratedImage[] = posts.map((p) => mkImage(p.imageId));

    render(
      <ApprovalQueue
        posts={posts}
        images={images}
        ideas={[]}
        onApprove={() => {}}
        onReject={() => {}}
        onBulkApprove={() => {}}
        onBulkReject={() => {}}
        onUpdateCaption={() => {}}
      />,
    );

    // No "Carousel · N" chip — the lone post is a single card.
    expect(screen.queryAllByText(/Carousel · \d+/i)).toHaveLength(0);
    // And no whole-carousel reject control either — singles use the
    // standard per-post reject affordance.
    expect(screen.queryAllByRole('button', { name: /reject carousel/i })).toHaveLength(0);
  });

  it('passes the full sibling postIds array to onUpdateCaption from a carousel card', () => {
    const posts = [
      mkPost('c1', { carouselGroupId: 'g1', caption: 'old' }),
      mkPost('c2', { carouselGroupId: 'g1', caption: 'old' }),
    ];
    const images: GeneratedImage[] = posts.map((p) => mkImage(p.imageId));
    const onUpdateCaption = vi.fn();

    const { container } = render(
      <ApprovalQueue
        posts={posts}
        images={images}
        ideas={[]}
        onApprove={() => {}}
        onReject={() => {}}
        onBulkApprove={() => {}}
        onBulkReject={() => {}}
        onUpdateCaption={onUpdateCaption}
      />,
    );

    // Click the caption to enter edit mode, then save.
    const editTrigger = within(container).getByRole('button', { name: /edit caption/i });
    fireEvent.click(editTrigger);
    const textarea = within(container).getByRole('textbox', { name: /caption editor/i });
    fireEvent.change(textarea, { target: { value: 'NEW' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onUpdateCaption).toHaveBeenCalledTimes(1);
    expect(onUpdateCaption).toHaveBeenCalledWith(['c1', 'c2'], 'NEW');
  });
});
