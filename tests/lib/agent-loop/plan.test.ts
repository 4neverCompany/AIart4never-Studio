/**
 * v1.2 — Director Route 2.0 plan-step tests.
 *
 * Pure-function tests for the system prompt, user prompt,
 * and initial step builder. No IO, no time.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDirectorPlan,
  buildDirectorSystemPrompt,
  buildUserPrompt,
  buildInitialPlanStep,
} from '@/lib/agent-loop/plan';

const baseContext = {
  niches: ['Multiverse Crossovers', 'Mythic Legends'],
  genres: ['Noir & Gritty'],
  ideaConcept: 'Darth Vader in Iron Man suit',
};

describe('buildDirectorPlan', () => {
  it('returns a non-empty string', () => {
    const out = buildDirectorPlan(baseContext);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('lists the 6 step names in order', () => {
    const out = buildDirectorPlan(baseContext);
    expect(out).toMatch(/trending_search/);
    expect(out).toMatch(/generate_prompt/);
    expect(out).toMatch(/critique_prompt/);
    expect(out).toMatch(/Finalize/);
  });

  it('includes the user\'s niches', () => {
    const out = buildDirectorPlan(baseContext);
    expect(out).toContain('Multiverse Crossovers');
    expect(out).toContain('Mythic Legends');
  });

  it('includes the user\'s idea concept', () => {
    const out = buildDirectorPlan(baseContext);
    expect(out).toContain('Darth Vader in Iron Man suit');
  });

  it('handles empty niches gracefully', () => {
    const out = buildDirectorPlan({ ...baseContext, niches: [] });
    expect(out).toMatch(/No niches supplied/);
  });

  it('handles no skills', () => {
    const out = buildDirectorPlan({ ...baseContext, skillContext: [] });
    expect(out).toMatch(/No skills active/);
  });

  it('lists active skill names when provided', () => {
    const out = buildDirectorPlan({
      ...baseContext,
      skillContext: [{ name: 'framing:camera-angles' }, { name: 'voice:noir' }],
    });
    expect(out).toContain('framing:camera-angles');
    expect(out).toContain('voice:noir');
  });
});

describe('buildDirectorSystemPrompt', () => {
  it('starts with the Director persona', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/Director agent of MashupForge/);
  });

  it('embeds the plan', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/Director plan/);
    expect(out).toMatch(/trending_search/);
  });

  it('includes the 0\.7 critique threshold as a directive', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/0\.7/);
  });

  it('tells the model the final text MUST be the prompt', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/final assistant text is what the user sees/);
  });
});

describe('buildUserPrompt', () => {
  it('starts with "Angle:"', () => {
    const out = buildUserPrompt(baseContext);
    expect(out).toMatch(/^Angle: /);
  });

  it('lists the niches and genres', () => {
    const out = buildUserPrompt(baseContext);
    expect(out).toContain('Niches: Multiverse Crossovers, Mythic Legends');
    expect(out).toContain('Genres: Noir & Gritty');
  });

  it('substitutes (none) for empty niches / genres', () => {
    const out = buildUserPrompt({ ...baseContext, niches: [], genres: [] });
    expect(out).toContain('Niches: (none)');
    expect(out).toContain('Genres: (none)');
  });

  it('ends with the execute-the-plan directive', () => {
    const out = buildUserPrompt(baseContext);
    expect(out).toMatch(/Execute the director plan/);
  });
});

describe('buildInitialPlanStep', () => {
  it('returns type=plan, cost=0', () => {
    const step = buildInitialPlanStep(baseContext, { timestamp: 1234 });
    expect(step.type).toBe('plan');
    expect(step.cost).toBe(0);
    expect(step.timestamp).toBe(1234);
  });

  it('includes the plan text in reasoning', () => {
    const step = buildInitialPlanStep(baseContext, { timestamp: 1 });
    expect(step.reasoning).toContain('trending_search');
  });

  it('uses the injected clock when no timestamp is provided', () => {
    let calls = 0;
    const clock = () => {
      calls += 1;
      return 9999;
    };
    const step = buildInitialPlanStep(baseContext, { clock });
    expect(step.timestamp).toBe(9999);
    expect(calls).toBe(1);
  });
});
