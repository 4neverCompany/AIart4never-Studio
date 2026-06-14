// V060-001: post-ready card status derivation moved to a shared helper
// (lib/post-ready-status.derivePostReadyStatus) so the single-image and
// carousel cards stay in lockstep. This test file kept the BUG-CRIT-007
// regression coverage and now points at the shared helper directly.
//
// Bug: pre-fix, the carousel branch only read anchor.postedAt /
// anchor.postError — i.e. the manual Post Now path. The auto-poster
// writes status to ScheduledPost.status, which the carousel branch
// never inspected. So an auto-posted carousel showed no badge after
// reload, even though the data was sitting in settings.scheduledPosts
// with status: 'posted'.

import { describe, it, expect } from 'vitest';
import type { GeneratedImage, ScheduledPost } from '@/types/mashup';
import { derivePostReadyStatus } from '@/lib/post-ready-status';

const mkAnchor = (overrides: Partial<GeneratedImage> = {}): GeneratedImage => ({
  id: 'anchor-1',
  prompt: 'p',
  url: 'https://example.test/a.png',
  ...overrides,
});

const mkPost = (overrides: Partial<ScheduledPost> = {}): ScheduledPost => ({
  id: 'post-1',
  imageId: 'anchor-1',
  date: '2026-04-25',
  time: '18:00',
  platforms: ['instagram'],
  caption: 'cap',
  status: 'scheduled',
  ...overrides,
});

describe('BUG-CRIT-007 — carousel/single-image status derivation (shared helper)', () => {
  describe('manual Post Now path (anchor.postedAt / postError) — wins over schedule', () => {
    it('renders Posted with platforms when anchor.postedAt is set', () => {
      const s = derivePostReadyStatus(
        mkAnchor({ postedAt: 1234, postedTo: ['instagram', 'discord'] }),
        undefined,
      );
      expect(s).toEqual({ kind: 'posted', label: 'Posted to instagram, discord' });
    });

    it('renders Posted (no platforms) when postedTo is empty', () => {
      const s = derivePostReadyStatus(mkAnchor({ postedAt: 1234 }), undefined);
      expect(s).toEqual({ kind: 'posted', label: 'Posted' });
    });

    it('renders Failed when anchor.postError is set', () => {
      const s = derivePostReadyStatus(
        mkAnchor({ postError: 'Token expired' }),
        undefined,
      );
      expect(s).toEqual({ kind: 'failed', label: 'Failed: Token expired' });
    });

    it('manual postedAt wins over a scheduled post still pending', () => {
      const s = derivePostReadyStatus(
        mkAnchor({ postedAt: 1234, postedTo: ['twitter'] }),
        mkPost({ status: 'scheduled' }),
      );
      expect(s.kind).toBe('posted');
      expect(s.label).toBe('Posted to twitter');
    });
  });

  describe('auto-poster path (ScheduledPost.status) — the BUG-CRIT-007 regression coverage', () => {
    it('renders Posted when ScheduledPost.status is posted (no anchor.postedAt)', () => {
      const s = derivePostReadyStatus(mkAnchor(), mkPost({ status: 'posted' }));
      expect(s).toEqual({ kind: 'posted', label: 'Posted' });
    });

    it('renders Failed when ScheduledPost.status is failed (no anchor.postError)', () => {
      const s = derivePostReadyStatus(mkAnchor(), mkPost({ status: 'failed' }));
      expect(s).toEqual({ kind: 'failed', label: 'Failed' });
    });

    it('renders Scheduled with date/time when status is scheduled', () => {
      const s = derivePostReadyStatus(
        mkAnchor(),
        mkPost({ status: 'scheduled', date: '2026-05-01', time: '14:30' }),
      );
      expect(s.kind).toBe('scheduled');
      // V082-UI-FIX: label now uses compact `MMM D` so the carousel
      // card status row fits on one line in grid-cols-2 layouts.
      expect(s.label).toMatch(/^Scheduled May 1/);
    });
  });

  describe('default — Ready (no badge)', () => {
    it('returns Ready when there is no manual state and no schedule', () => {
      const s = derivePostReadyStatus(mkAnchor(), undefined);
      expect(s).toEqual({ kind: 'ready', label: 'Ready' });
    });

    it('renders pending_approval as a scheduled-class status (visible in V060-001)', () => {
      // V060-001: previous behavior returned no badge for pending_approval;
      // the redesign surfaces it as a scheduled-class state so the colored
      // border + pill make the lifecycle visible at a glance.
      const s = derivePostReadyStatus(
        mkAnchor(),
        mkPost({ status: 'pending_approval' }),
      );
      expect(s.kind).toBe('scheduled');
      expect(s.label).toMatch(/Pending approval/);
    });

    it('returns Ready when scheduled post is rejected (terminal but not visible as a badge)', () => {
      const s = derivePostReadyStatus(mkAnchor(), mkPost({ status: 'rejected' }));
      expect(s).toEqual({ kind: 'ready', label: 'Ready' });
    });
  });
});
