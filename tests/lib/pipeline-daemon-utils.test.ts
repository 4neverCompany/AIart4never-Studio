// V040-008 + V040-HOTFIX-001: per-platform approval gating tests.

import { describe, it, expect } from 'vitest';
import {
  isPlatformAutoApproved,
  resolvePipelinePostStatus,
  applyV040AutoApproveMigration,
  applyV160DirectorDefaultMigration,
  applySettingsMigrations,
} from '@/lib/pipeline-daemon-utils';

describe('isPlatformAutoApproved', () => {
  it('defaults every known platform to auto-approval (V040-HOTFIX-001)', () => {
    expect(isPlatformAutoApproved('instagram', undefined)).toBe(true);
    expect(isPlatformAutoApproved('pinterest', undefined)).toBe(true);
    expect(isPlatformAutoApproved('twitter', undefined)).toBe(true);
    expect(isPlatformAutoApproved('discord', undefined)).toBe(true);
  });

  it('treats an empty config object the same as missing config', () => {
    expect(isPlatformAutoApproved('instagram', {})).toBe(true);
    expect(isPlatformAutoApproved('twitter', {})).toBe(true);
  });

  it('respects explicit user overrides', () => {
    expect(isPlatformAutoApproved('instagram', { instagram: false })).toBe(false);
    expect(isPlatformAutoApproved('twitter', { twitter: false })).toBe(false);
    expect(isPlatformAutoApproved('pinterest', { pinterest: true })).toBe(true);
  });

  it('treats unknown platforms as manual approval (defensive)', () => {
    expect(isPlatformAutoApproved('myspace', undefined)).toBe(false);
  });
});

describe('resolvePipelinePostStatus (BUG-CRIT-001 — always pending_approval)', () => {
  // Every pipeline-produced post now gates through approval, regardless
  // of platform set or pipelineAutoApprove config. This is the core
  // safety + watermark fix from BUG-CRIT-001.

  it('returns pending_approval for any single auto-approved platform', () => {
    expect(resolvePipelinePostStatus(['twitter'], undefined)).toBe('pending_approval');
    expect(resolvePipelinePostStatus(['discord'], undefined)).toBe('pending_approval');
    expect(resolvePipelinePostStatus(['instagram'], undefined)).toBe('pending_approval');
    expect(resolvePipelinePostStatus(['pinterest'], undefined)).toBe('pending_approval');
  });

  it('returns pending_approval for multi-platform posts', () => {
    expect(
      resolvePipelinePostStatus(['twitter', 'discord', 'instagram'], undefined),
    ).toBe('pending_approval');
  });

  it('ignores pipelineAutoApprove config — even an explicit all-true map gates', () => {
    expect(
      resolvePipelinePostStatus(['twitter', 'instagram'], {
        instagram: true,
        twitter: true,
        discord: true,
        pinterest: true,
      }),
    ).toBe('pending_approval');
  });

  it('returns pending_approval for an empty platforms array', () => {
    expect(resolvePipelinePostStatus([], undefined)).toBe('pending_approval');
  });
});

describe('applyV040AutoApproveMigration (V040-HOTFIX-001)', () => {
  it('writes an explicit auto-everywhere map when the field is absent', () => {
    const out = applyV040AutoApproveMigration({ otherField: 'x' } as { otherField: string; pipelineAutoApprove?: Record<string, boolean> });
    expect(out.pipelineAutoApprove).toEqual({
      instagram: true,
      pinterest: true,
      twitter: true,
      discord: true,
    });
  });

  it('is a no-op when the user has already configured the field', () => {
    const input = { pipelineAutoApprove: { instagram: false } };
    const out = applyV040AutoApproveMigration(input);
    expect(out).toBe(input);
    expect(out.pipelineAutoApprove).toEqual({ instagram: false });
  });

  it('is a no-op when the field is already an empty object (treated as user-configured)', () => {
    const input = { pipelineAutoApprove: {} };
    const out = applyV040AutoApproveMigration(input);
    expect(out).toBe(input);
  });

  it('preserves all other fields on the migrated payload', () => {
    const input = { someOtherField: 42, watermark: { enabled: true } };
    const out = applyV040AutoApproveMigration(input as { someOtherField: number; watermark: { enabled: boolean }; pipelineAutoApprove?: Record<string, boolean> });
    expect(out.someOtherField).toBe(42);
    expect(out.watermark).toEqual({ enabled: true });
  });
});

describe('applyV160DirectorDefaultMigration (V1.6 — Director default)', () => {
  it('flips a stored false from the old opt-in default to true', () => {
    // The pre-v1.6 store state for every user who never touched the
    // toggle: explicit false from the old defaultSettings merge.
    const out = applyV160DirectorDefaultMigration({ useDirectorPipeline: false });
    expect(out.useDirectorPipeline).toBe(true);
  });

  it('turns the Director on when the field is absent (pre-v1.5 stores)', () => {
    const out = applyV160DirectorDefaultMigration({} as { useDirectorPipeline?: boolean });
    expect(out.useDirectorPipeline).toBe(true);
  });

  it('is a referential no-op when the Director is already on', () => {
    const input = { useDirectorPipeline: true };
    expect(applyV160DirectorDefaultMigration(input)).toBe(input);
  });

  it('never overrides an explicit user opt-out (directorPipelineUserSet)', () => {
    const input = { useDirectorPipeline: false, directorPipelineUserSet: true };
    const out = applyV160DirectorDefaultMigration(input);
    expect(out).toBe(input);
    expect(out.useDirectorPipeline).toBe(false);
  });

  it('is idempotent — a second pass returns the first pass unchanged', () => {
    const once = applyV160DirectorDefaultMigration({ useDirectorPipeline: false });
    const twice = applyV160DirectorDefaultMigration(once);
    expect(twice).toBe(once);
  });

  it('preserves all other fields on the migrated payload', () => {
    const input = { someOtherField: 42, useDirectorPipeline: false };
    const out = applyV160DirectorDefaultMigration(input);
    expect(out.someOtherField).toBe(42);
  });
});

describe('applySettingsMigrations (composition)', () => {
  it('applies both the V040 and V160 migrations in one pass', () => {
    const out = applySettingsMigrations({ useDirectorPipeline: false } as {
      useDirectorPipeline?: boolean;
      directorPipelineUserSet?: boolean;
      pipelineAutoApprove?: Record<string, boolean>;
    });
    expect(out.useDirectorPipeline).toBe(true);
    expect(out.pipelineAutoApprove).toEqual({
      instagram: true,
      pinterest: true,
      twitter: true,
      discord: true,
    });
  });

  it('is a referential no-op when nothing needs migrating', () => {
    const input = {
      useDirectorPipeline: true,
      pipelineAutoApprove: { instagram: false },
    };
    expect(applySettingsMigrations(input)).toBe(input);
  });

  it('respects an explicit Director opt-out while still migrating auto-approve', () => {
    const out = applySettingsMigrations({
      useDirectorPipeline: false,
      directorPipelineUserSet: true,
    } as {
      useDirectorPipeline?: boolean;
      directorPipelineUserSet?: boolean;
      pipelineAutoApprove?: Record<string, boolean>;
    });
    expect(out.useDirectorPipeline).toBe(false);
    expect(out.pipelineAutoApprove).toBeDefined();
  });
});
