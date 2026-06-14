import { describe, it, expect } from 'vitest';
import { extractJsonArrayFromLLM, extractJsonObjectFromLLM, stripThinkBlocks } from '@/lib/aiClient';

describe('extractJsonArrayFromLLM', () => {
  it('parses a clean JSON array', () => {
    expect(extractJsonArrayFromLLM('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', () => {
    const raw = '```json\n[{"a":1},{"a":2}]\n```';
    expect(extractJsonArrayFromLLM(raw)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('strips bare ``` fences', () => {
    expect(extractJsonArrayFromLLM('```\n[]\n```')).toEqual([]);
  });

  it('slices commentary before and after the array', () => {
    const raw = 'Sure! Here you go:\n[1, 2]\nLet me know if you need more.';
    expect(extractJsonArrayFromLLM(raw)).toEqual([1, 2]);
  });

  it('returns [] for empty input', () => {
    expect(extractJsonArrayFromLLM('')).toEqual([]);
    expect(extractJsonArrayFromLLM('   ')).toEqual([]);
  });

  it('returns [] when the LLM returns an object instead of an array', () => {
    expect(extractJsonArrayFromLLM('{"foo":"bar"}')).toEqual([]);
  });

  it('returns [] when the LLM returns malformed JSON', () => {
    expect(extractJsonArrayFromLLM('not json at all')).toEqual([]);
  });

  it('handles nested arrays inside the slice', () => {
    expect(extractJsonArrayFromLLM('[[1,2],[3,4]]')).toEqual([[1, 2], [3, 4]]);
  });

  it('preserves object items inside the array as plain unknown values', () => {
    const result = extractJsonArrayFromLLM('[{"prompt":"x","tags":["a"]}]');
    expect(result).toEqual([{ prompt: 'x', tags: ['a'] }]);
  });
});

describe('extractJsonObjectFromLLM', () => {
  it('parses a clean JSON object', () => {
    expect(extractJsonObjectFromLLM('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
  });

  it('strips ```json fences', () => {
    expect(extractJsonObjectFromLLM('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('slices commentary before and after the object', () => {
    const raw = 'Here is the result:\n{"score": 42}\nHope that helps.';
    expect(extractJsonObjectFromLLM(raw)).toEqual({ score: 42 });
  });

  it('returns {} for empty input', () => {
    expect(extractJsonObjectFromLLM('')).toEqual({});
  });

  it('returns {} when the LLM returns an array instead of an object', () => {
    expect(extractJsonObjectFromLLM('[1,2,3]')).toEqual({});
  });

  it('returns {} when the LLM returns malformed JSON', () => {
    expect(extractJsonObjectFromLLM('totally broken')).toEqual({});
  });

  it('returns {} when the LLM returns a JSON literal null', () => {
    expect(extractJsonObjectFromLLM('null')).toEqual({});
  });

  it('handles nested objects', () => {
    const raw = '{"outer":{"inner":{"deep":1}}}';
    expect(extractJsonObjectFromLLM(raw)).toEqual({ outer: { inner: { deep: 1 } } });
  });
});

// Regression guard for commit c8b469f (2026-05-20). The pipeline path
// — expandIdeaToPrompt → streamAIToString → Leonardo image prompt —
// forwards the raw text. Reasoning models (MiniMax-M2.5, GLM-5.1,
// DeepSeek-R1) prefix their answer with <think>…</think>; if it leaks
// through, Leonardo rejects the oversized prompt while MiniMax-image
// silently truncates at 1500 chars and tolerates it, producing the
// "only MiniMax generates in Pipeline" symptom.
describe('stripThinkBlocks', () => {
  it('removes a single <think>…</think> block', () => {
    expect(stripThinkBlocks('<think>reasoning here</think>final answer'))
      .toBe('final answer');
  });

  it('removes multi-line think blocks across newlines', () => {
    const raw = '<think>line 1\nline 2\nline 3</think>\nactual prompt';
    expect(stripThinkBlocks(raw)).toBe('actual prompt');
  });

  it('removes multiple think blocks', () => {
    const raw = '<think>first</think>middle<think>second</think>tail';
    expect(stripThinkBlocks(raw)).toBe('middletail');
  });

  it('drops an unterminated leading <think> block (truncated model output)', () => {
    expect(stripThinkBlocks('<think>started thinking but cut off'))
      .toBe('');
  });

  it('returns the trimmed input when no think tags are present', () => {
    expect(stripThinkBlocks('  just an answer  ')).toBe('just an answer');
  });

  it('is idempotent on already-clean input', () => {
    const clean = 'A clean image prompt.';
    expect(stripThinkBlocks(stripThinkBlocks(clean))).toBe(clean);
  });

  it('preserves brace/bracket content outside think blocks', () => {
    const raw = '<think>{ "fake": "json in reasoning" }</think>{"real":42}';
    expect(stripThinkBlocks(raw)).toBe('{"real":42}');
  });
});
