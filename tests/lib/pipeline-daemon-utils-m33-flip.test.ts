import { describe, it, expect } from 'vitest';
import {
  applyM33AiAgentFlip,
  applySettingsMigrations,
} from '@/lib/pipeline-daemon-utils';

// M3.3-P3 commit a: the legacy `activeAiAgent: 'pi' | 'nca' | 'mmx'`
// literal values no longer match the narrowed `'vercel-ai'` type
// (MashupForge's UserSettings now permits only `'vercel-ai'`). The
// migration shim still has to *handle* the legacy strings — that's
// the whole point of the rewrite — so the tests cast through `unknown`
// to reach the shim's input type without disabling the production
// type narrowing at call sites.
type LegacyActiveAiAgent = 'pi' | 'nca' | 'mmx' | 'vercel-ai';
const legacy = (v: LegacyActiveAiAgent): string => v as string;

describe('applyM33AiAgentFlip', () => {
  it('rewrites activeAiAgent=pi to vercel-ai', () => {
    const out = applyM33AiAgentFlip({ activeAiAgent: legacy('pi') });
    expect(out.activeAiAgent).toBe('vercel-ai');
  });

  it('rewrites activeAiAgent=nca to vercel-ai', () => {
    expect(applyM33AiAgentFlip({ activeAiAgent: legacy('nca') }).activeAiAgent).toBe('vercel-ai');
  });

  it('rewrites activeAiAgent=mmx to vercel-ai', () => {
    expect(applyM33AiAgentFlip({ activeAiAgent: legacy('mmx') }).activeAiAgent).toBe('vercel-ai');
  });

  it('rewrites aiAgentProvider independently of activeAiAgent', () => {
    const out = applyM33AiAgentFlip({ aiAgentProvider: legacy('pi') } as { activeAiAgent?: string; aiAgentProvider?: string });
    expect(out.aiAgentProvider).toBe('vercel-ai');
    expect(out.activeAiAgent).toBeUndefined();
  });

  it('rewrites both fields when both are legacy', () => {
    const out = applyM33AiAgentFlip({ activeAiAgent: legacy('pi'), aiAgentProvider: legacy('nca') });
    expect(out.activeAiAgent).toBe('vercel-ai');
    expect(out.aiAgentProvider).toBe('vercel-ai');
  });

  it('returns the input reference unchanged when both are already vercel-ai', () => {
    const input = { activeAiAgent: 'vercel-ai', aiAgentProvider: 'vercel-ai' };
    expect(applyM33AiAgentFlip(input)).toBe(input);
  });

  it('returns the input reference unchanged when both are undefined', () => {
    const input = {} as { activeAiAgent?: string; aiAgentProvider?: string };
    expect(applyM33AiAgentFlip(input)).toBe(input);
  });

  it('does not touch unrelated fields', () => {
    const out = applyM33AiAgentFlip({
      activeAiAgent: legacy('pi'),
      channelName: 'MultiverseMashupAI',
      watermark: { enabled: true },
    });
    expect(out.channelName).toBe('MultiverseMashupAI');
    expect(out.watermark).toEqual({ enabled: true });
  });
});

describe('applySettingsMigrations — M3.3-P3 ai-flip integration', () => {
  it('flips activeAiAgent from pi to vercel-ai as part of the chain', () => {
    const out = applySettingsMigrations({
      activeAiAgent: legacy('pi'),
      aiAgentProvider: legacy('pi'),
      pipelineAutoApprove: { instagram: true, pinterest: true, twitter: true, discord: true },
    });
    expect(out.activeAiAgent).toBe('vercel-ai');
    expect(out.aiAgentProvider).toBe('vercel-ai');
  });

  it('leaves a fresh-install defaults-shaped input untouched (referential)', () => {
    const input = {
      activeAiAgent: 'vercel-ai' as const,
      aiAgentProvider: 'vercel-ai' as const,
      pipelineAutoApprove: { instagram: true, pinterest: true, twitter: true, discord: true },
      useDirectorPipeline: true,
      directorPipelineUserSet: false,
    };
    expect(applySettingsMigrations(input)).toBe(input);
  });
});
