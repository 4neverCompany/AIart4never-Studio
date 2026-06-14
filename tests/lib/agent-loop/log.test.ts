/**
 * v1.2 — Director Route 2.0 step-logger tests.
 *
 * Pure unit tests: no async, no IO, no time. The logger is
 * the cheapest moving part of the loop and gets the most
 * coverage here.
 */
import { describe, it, expect } from 'vitest';
import { StepLogger, truncateForLog } from '@/lib/agent-loop/log';

describe('StepLogger — append / getAll', () => {
  it('starts empty', () => {
    const log = new StepLogger();
    expect(log.size()).toBe(0);
    expect(log.getAll()).toEqual([]);
    expect(log.totalCost()).toBe(0);
  });

  it('overwrites idx with the monotonic counter', () => {
    const log = new StepLogger();
    const a = log.append({
      type: 'plan',
      reasoning: 'plan text',
      cost: 0,
      timestamp: 1,
    });
    const b = log.append({
      type: 'tool_call',
      tool: 'trending_search',
      cost: 0.001,
      timestamp: 2,
    });
    expect(a.idx).toBe(0);
    expect(b.idx).toBe(1);
  });

  it('ignores a caller-supplied idx on the input', () => {
    const log = new StepLogger();
    const a = log.append({
      type: 'plan',
      cost: 0,
      timestamp: 1,
      // @ts-expect-error — idx is intentionally not part of the input type
      idx: 99,
    });
    expect(a.idx).toBe(0);
  });

  it('preserves all other fields on the stored record', () => {
    const log = new StepLogger();
    const a = log.append({
      type: 'tool_call',
      tool: 'generate_prompt',
      input: { niches: ['Marvel'] },
      reasoning: 'drafting…',
      cost: 0.0123,
      timestamp: 42,
      durationMs: 300,
    });
    expect(a).toEqual({
      idx: 0,
      type: 'tool_call',
      tool: 'generate_prompt',
      input: { niches: ['Marvel'] },
      reasoning: 'drafting…',
      cost: 0.0123,
      timestamp: 42,
      durationMs: 300,
    });
  });

  it('returns a readonly view of the chronological log', () => {
    const log = new StepLogger();
    log.append({ type: 'plan', cost: 0, timestamp: 1 });
    log.append({ type: 'final', cost: 0.05, timestamp: 2 });
    const all = log.getAll();
    expect(all).toHaveLength(2);
    expect(all[0]?.type).toBe('plan');
    expect(all[1]?.type).toBe('final');
  });
});

describe('StepLogger — totalCost', () => {
  it('sums every step.cost', () => {
    const log = new StepLogger();
    log.append({ type: 'plan', cost: 0, timestamp: 1 });
    log.append({ type: 'tool_call', cost: 0.01, timestamp: 2 });
    log.append({ type: 'tool_result', cost: 0, timestamp: 3 });
    log.append({ type: 'final', cost: 0.04, timestamp: 4 });
    expect(log.totalCost()).toBeCloseTo(0.05, 6);
  });

  it('treats missing cost as 0', () => {
    const log = new StepLogger();
    log.append({ type: 'plan', cost: 0, timestamp: 1 });
    log.append({ type: 'final', cost: 0.02, timestamp: 2 });
    expect(log.totalCost()).toBeCloseTo(0.02, 6);
  });
});

describe('StepLogger — clock injection', () => {
  it('does not consult the clock on append (caller passes timestamp)', () => {
    let calls = 0;
    const clock = () => {
      calls += 1;
      return 0;
    };
    const log = new StepLogger({ clock });
    log.append({ type: 'plan', cost: 0, timestamp: 99 });
    expect(calls).toBe(0);
  });
});

describe('truncateForLog', () => {
  it('returns primitives unchanged', () => {
    expect(truncateForLog(null)).toBe(null);
    expect(truncateForLog(undefined)).toBe(undefined);
    expect(truncateForLog(0)).toBe(0);
    expect(truncateForLog(42)).toBe(42);
    expect(truncateForLog(true)).toBe(true);
  });

  it('truncates long strings', () => {
    const long = 'a'.repeat(5000);
    const out = truncateForLog(long) as string;
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain('[truncated');
  });

  it('keeps short strings unchanged', () => {
    expect(truncateForLog('hello')).toBe('hello');
  });

  it('recursively truncates array elements', () => {
    const arr = ['a'.repeat(5000), 'short'];
    const out = truncateForLog(arr) as string[];
    expect(out[0]?.length).toBeLessThan(5000);
    expect(out[1]).toBe('short');
  });

  it('recursively truncates object fields', () => {
    const obj = { title: 'short', body: 'b'.repeat(5000) };
    const out = truncateForLog(obj) as { title: string; body: string };
    expect(out.title).toBe('short');
    expect(out.body.length).toBeLessThan(5000);
  });

  it('handles nested structures', () => {
    const nested = { outer: { inner: ['x'.repeat(5000)] } };
    const out = truncateForLog(nested) as { outer: { inner: string[] } };
    expect(out.outer.inner[0]?.length).toBeLessThan(5000);
  });
});
