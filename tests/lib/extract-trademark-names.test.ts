import { describe, it, expect } from 'vitest';
import { extractTrademarkNames, TRADEMARK_SEED_LIST } from '@/lib/extract-trademark-names';

describe('extractTrademarkNames', () => {
  it('finds canonical names case-insensitively', () => {
    const out = extractTrademarkNames('a cinematic shot of spider-man swinging through tokyo');
    expect(out).toContain('Spider-Man');
  });

  it('returns the canonical casing from the seed list, not the prompt casing', () => {
    // Prompt has lowercase "batman"; result should be canonical "Batman".
    const out = extractTrademarkNames('batman scowls at the bat-signal');
    expect(out).toContain('Batman');
    expect(out).not.toContain('batman');
  });

  it('multi-word matches win over their single-word fragments', () => {
    // "Miles Morales" should be picked AS A SET; the bare-word "Miles"
    // is not in the seed list, but the seed ordering matters when more
    // ambiguous overlaps land (e.g. "Peter Parker" vs a future "Peter").
    const out = extractTrademarkNames('Miles Morales perches on a rooftop');
    expect(out).toContain('Miles Morales');
  });

  it('handles multiple distinct names in the same prompt', () => {
    const out = extractTrademarkNames('Jeff the Land Shark vs Grogu in a Mandalorian standoff');
    expect(out).toContain('Grogu');
    expect(out).toContain('Mandalorian');
  });

  it('returns empty for a prompt with no seed names', () => {
    expect(extractTrademarkNames('a neon cyberpunk vista with original characters')).toEqual([]);
  });

  it('handles empty / undefined-shape inputs without throwing', () => {
    expect(extractTrademarkNames('')).toEqual([]);
  });

  it('seed list is non-empty and exposes canonical names', () => {
    expect(TRADEMARK_SEED_LIST.length).toBeGreaterThan(20);
    expect(TRADEMARK_SEED_LIST).toContain('Spider-Man');
    expect(TRADEMARK_SEED_LIST).toContain('Grogu');
    expect(TRADEMARK_SEED_LIST).toContain('Astartes');
  });
});
