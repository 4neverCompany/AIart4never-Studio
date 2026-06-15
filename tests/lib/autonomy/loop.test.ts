/**
 * M2 keystone — AUTONOMY LOOP orchestrator tests.
 *
 * All side effects are injected (no real clock / storage / LLM / network):
 *   - a generate-day (Friday Story-Beat) calls runDirector THEN persistAsset and
 *     returns decision:'generate', queued:true;
 *   - a reuse-day (Monday Variant-Reveal with a stocked library) calls NEITHER
 *     runDirector NOR persistAsset and returns a library asset id;
 *   - a no-slot day (Saturday) → decision:'skip', queued:false;
 *   - a runDirector that throws → error set, queued:false, NO crash;
 *   - the loop CANNOT publish — there is no publish dep in AutonomyTickDeps and
 *     this module imports nothing from lib/publish (asserted below).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runAutonomyTick, runAutonomyOnceIfDue, type AutonomyTickDeps } from '@/lib/autonomy/loop';
import { canonTags } from '@/lib/canon/content-plan';
import type { AutonomyConfig } from '@/lib/autonomy/types';
import type { RunDirectorLoopResult } from '@/lib/agent-loop';
import type { GeneratedImage } from '@/types/mashup';

type RunDirectorFn = AutonomyTickDeps['runDirector'];
type PersistAssetFn = AutonomyTickDeps['persistAsset'];

function cfg(over: Partial<AutonomyConfig> = {}): AutonomyConfig {
  return {
    enabled: true,
    cadence: 'daily',
    activeCharacterId: 'kael',
    dailyBudgetUsd: 0.5,
    tickHourLocal: 9,
    ...over,
  };
}

// Canon weekdays (local): 2026-06-15 = Monday (variant-reveal, reuse-capable),
// 2026-06-19 = Friday (story-beat, guaranteesNewGen → generate),
// 2026-06-20 = Saturday (NO slot → skip).
const MONDAY = new Date(2026, 5, 15, 9, 0, 0, 0);
const FRIDAY = new Date(2026, 5, 19, 9, 0, 0, 0);
const SATURDAY = new Date(2026, 5, 20, 9, 0, 0, 0);

/** A library asset on-canon for kael + a given pillar (so reuse-first matches). */
function libAsset(pillarId: string, over: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    id: `img-${pillarId}`,
    url: 'https://cdn.example/x.png',
    prompt: 'p',
    tags: canonTags('kael', pillarId),
    savedAt: 1_000,
    ...over,
  };
}

/** A canned director result whose last generate_image step carries an assetRef. */
function directorResultWithAsset(
  over: Partial<RunDirectorLoopResult> = {},
): RunDirectorLoopResult {
  return {
    runId: 'run_test',
    finalPrompt: 'a clean canon prompt for the story beat',
    steps: [
      { idx: 0, type: 'plan', cost: 0, timestamp: 1 },
      {
        idx: 1,
        type: 'tool_result',
        tool: 'generate_image',
        output: {
          assetRef: { provider: 'higgsfield', id: 'gen-999', url: 'https://cdn.example/gen.png' },
          creditsCharged: 4,
        },
        cost: 0,
        timestamp: 2,
      },
    ],
    totalCost: 0.12,
    truncatedBy: 'natural',
    modelId: 'MiniMax-M3',
    provider: 'minimax',
    tokensUsed: { input: 100, output: 50 },
    ...over,
  };
}

describe('runAutonomyTick — reuse day (Monday Variant-Reveal)', () => {
  it('queues a library asset and calls NEITHER the director nor persist', async () => {
    const runDirector = vi.fn();
    const persistAsset = vi.fn();
    const result = await runAutonomyTick(cfg(), {
      now: MONDAY,
      loadLibrary: async () => [libAsset('variant-reveal')],
      runDirector,
      persistAsset,
    });

    expect(result.decision).toBe('reuse');
    expect(result.queued).toBe(true);
    expect(result.assetId).toBe('img-variant-reveal');
    expect(result.day).toBe('mon');
    // The whole point of reuse-first: no generation, no new persist.
    expect(runDirector).not.toHaveBeenCalled();
    expect(persistAsset).not.toHaveBeenCalled();
  });
});

describe('runAutonomyTick — generate day (Friday Story-Beat)', () => {
  it('calls runDirector THEN persistAsset, returns generate + queued', async () => {
    const order: string[] = [];
    const runDirector = vi.fn<RunDirectorFn>(async () => {
      order.push('director');
      return directorResultWithAsset();
    });
    const persistAsset = vi.fn<PersistAssetFn>(async () => {
      order.push('persist');
      return { assetId: 'image-gen-999' };
    });

    const result = await runAutonomyTick(cfg(), {
      now: FRIDAY,
      loadLibrary: async () => [],
      runDirector,
      persistAsset,
    });

    expect(result.decision).toBe('generate');
    expect(result.queued).toBe(true);
    expect(result.assetId).toBe('image-gen-999');
    expect(result.day).toBe('fri');
    expect(result.pillarId).toBe('story-beat');
    // Ordering: director first, then persist (the produced asset gets queued).
    expect(order).toEqual(['director', 'persist']);

    // The director got the canon character + per-tick budget.
    const dInput = runDirector.mock.calls[0]![0];
    expect(dInput.characterId).toBe('kael');
    expect(dInput.budgetUsd).toBe(0.5);
    expect(dInput.niches.length).toBeGreaterThanOrEqual(1);
    expect(dInput.ideaConcept.length).toBeGreaterThanOrEqual(3);

    // persist receives the director's produced assetRef and lands it with
    // canon facet tags (approved:false is enforced inside executePersistAsset).
    const pInput = persistAsset.mock.calls[0]![0];
    expect(pInput.assetRef).toEqual({
      provider: 'higgsfield',
      id: 'gen-999',
      url: 'https://cdn.example/gen.png',
    });
    expect(pInput.metadata.kind).toBe('image');
    expect(pInput.metadata.tags).toContain('character:kael');
    expect(pInput.metadata.tags).toContain('pillar:story-beat');
  });

  it('reflects a director budget stop in the note', async () => {
    const result = await runAutonomyTick(cfg(), {
      now: FRIDAY,
      loadLibrary: async () => [],
      runDirector: async () =>
        directorResultWithAsset({ truncatedBy: 'budget', totalCost: 0.5 }),
      persistAsset: async () => ({ assetId: 'image-gen-999' }),
    });
    expect(result.decision).toBe('generate');
    expect(result.queued).toBe(true);
    expect(result.note.toLowerCase()).toContain('budget');
  });

  it('handles a director run that produced no asset (no persist, not queued)', async () => {
    const persistAsset = vi.fn();
    const result = await runAutonomyTick(cfg(), {
      now: FRIDAY,
      loadLibrary: async () => [],
      runDirector: async () => directorResultWithAsset({ steps: [{ idx: 0, type: 'plan', cost: 0, timestamp: 1 }] }),
      persistAsset,
    });
    expect(result.decision).toBe('generate');
    expect(result.queued).toBe(false);
    expect(persistAsset).not.toHaveBeenCalled();
  });
});

describe('runAutonomyTick — no-slot day (Saturday)', () => {
  it('skips with queued:false and no side effects', async () => {
    const runDirector = vi.fn();
    const persistAsset = vi.fn();
    const result = await runAutonomyTick(cfg(), {
      now: SATURDAY,
      loadLibrary: async () => [],
      runDirector,
      persistAsset,
    });
    expect(result.decision).toBe('skip');
    expect(result.queued).toBe(false);
    expect(result.day).toBe('sat');
    expect(result.note).toContain('no slot');
    expect(runDirector).not.toHaveBeenCalled();
    expect(persistAsset).not.toHaveBeenCalled();
  });
});

describe('runAutonomyTick — failure isolation', () => {
  it('a runDirector that throws → error set, queued:false, no crash', async () => {
    const result = await runAutonomyTick(cfg(), {
      now: FRIDAY,
      loadLibrary: async () => [],
      runDirector: async () => {
        throw new Error('director exploded');
      },
      persistAsset: async () => ({ assetId: 'never' }),
    });
    expect(result.queued).toBe(false);
    expect(result.error).toBe('director exploded');
    // The result is well-formed (the scheduler can still advance).
    expect(result.day).toBe('fri');
    expect(typeof result.at).toBe('number');
  });

  it('a loadLibrary that throws is caught (failed tick never crashes)', async () => {
    const result = await runAutonomyTick(cfg(), {
      now: FRIDAY,
      loadLibrary: async () => {
        throw new Error('store unavailable');
      },
      runDirector: vi.fn(),
      persistAsset: vi.fn(),
    });
    expect(result.queued).toBe(false);
    expect(result.error).toBe('store unavailable');
  });
});

describe('runAutonomyOnceIfDue', () => {
  it('runs a tick and advances lastTickAt when due', async () => {
    const next = await runAutonomyOnceIfDue(
      cfg(),
      { lastTickAt: null },
      {
        now: FRIDAY,
        loadLibrary: async () => [],
        runDirector: async () => directorResultWithAsset(),
        persistAsset: async () => ({ assetId: 'image-gen-999' }),
      },
    );
    expect(next.lastTickAt).toBe(FRIDAY.getTime());
    expect(next.lastResult?.decision).toBe('generate');
  });

  it('returns state unchanged when not due (already ticked today)', async () => {
    const state = { lastTickAt: FRIDAY.getTime() };
    const runDirector = vi.fn();
    const next = await runAutonomyOnceIfDue(cfg(), state, {
      now: new Date(2026, 5, 19, 22, 0, 0, 0), // same local day, later hour
      loadLibrary: async () => [],
      runDirector,
      persistAsset: vi.fn(),
    });
    expect(next).toBe(state); // identity-unchanged
    expect(runDirector).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PROOF: the autonomy loop can NEVER publish.
// ---------------------------------------------------------------------------
describe('publish-safety invariant', () => {
  it('AutonomyTickDeps has no publish dependency (the loop cannot publish)', async () => {
    // There is no publish function in the deps surface at all — that absence is
    // itself the proof. A generate-day exercises EVERY dep the loop has
    // (loadLibrary, runDirector, persistAsset); none of them publishes, and
    // persistAsset lands the asset as approved:false (the human gate).
    const calls: string[] = [];
    await runAutonomyTick(cfg(), {
      now: FRIDAY,
      loadLibrary: async () => {
        calls.push('loadLibrary');
        return [];
      },
      runDirector: async () => {
        calls.push('runDirector');
        return directorResultWithAsset();
      },
      persistAsset: async () => {
        calls.push('persistAsset');
        return { assetId: 'image-gen-999' };
      },
    });
    // The ONLY side-effecting deps the loop invoked — no publish among them.
    expect(new Set(calls)).toEqual(new Set(['loadLibrary', 'runDirector', 'persistAsset']));
  });

  it('the loop source imports nothing from lib/publish', () => {
    // Static proof: scan the source for any IMPORT (static or dynamic) that
    // references the publish path. We match import/require statements only —
    // not prose comments — so the docstring that *mentions* lib/publish doesn't
    // trip the guard. Any real `from '@/lib/publish'` or `import('…/publish')`
    // would fail this.
    const src = readFileSync(resolve(process.cwd(), 'lib/autonomy/loop.ts'), 'utf8');
    const importLines = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l) || /\bimport\s*\(/.test(l) || /\brequire\s*\(/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/publish/);
    }
    // And no module specifier anywhere resolves to the publish path.
    expect(src).not.toMatch(/from\s+['"][^'"]*lib\/publish/);
    expect(src).not.toMatch(/(?:import|require)\s*\(\s*['"][^'"]*lib\/publish/);
  });
});
