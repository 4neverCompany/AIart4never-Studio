// V080-DES-003: pin the dynamic interpolation contract for the
// default agent prompt. The "Reset to Default" button used to write a
// hardcoded paragraph naming "Marvel, DC, Star Wars, Warhammer 40k"
// regardless of the user's selections — these tests prevent that
// regression by confirming the user's tags actually appear in the
// rendered prompt and the empty-state falls back gracefully.

import { describe, it, expect } from 'vitest';
import { buildDefaultAgentPrompt, DEFAULT_NICHES, DEFAULT_GENRES } from '@/lib/agent-prompt';

describe('buildDefaultAgentPrompt — V080-DES-003', () => {
  it('interpolates the user\'s niches into the prompt body', () => {
    const out = buildDefaultAgentPrompt({
      niches: ['Cyberpunk Cooking', 'Dieselpunk Politics'],
      genres: ['Noir'],
    });
    expect(out).toContain('Cyberpunk Cooking');
    expect(out).toContain('Dieselpunk Politics');
  });

  it('interpolates the user\'s genres into the prompt body', () => {
    const out = buildDefaultAgentPrompt({
      niches: ['Mythic Legends'],
      genres: ['Vaporwave', 'Afrofuturism', 'Solarpunk'],
    });
    expect(out).toContain('Vaporwave');
    expect(out).toContain('Afrofuturism');
    expect(out).toContain('Solarpunk');
  });

  it('truncates very long genre lists with a "and N more" tail', () => {
    const longGenres = Array.from({ length: 12 }, (_, i) => `Genre${i + 1}`);
    const out = buildDefaultAgentPrompt({ niches: ['Anything'], genres: longGenres });
    // First six are listed by name…
    for (let i = 1; i <= 6; i++) expect(out).toContain(`Genre${i}`);
    // …and the rest are summarised so the prompt stays readable.
    expect(out).toContain('and 6 more');
    expect(out).not.toContain('Genre12');
  });

  it('falls back to neutral phrasing when pillars/styles are empty', () => {
    // AI-ROLE-REDESIGN (2026-05-22): fallback vocab updated alongside
    // the persona — "niche" → "space" to match the Content Pillars
    // framing.
    const out = buildDefaultAgentPrompt({ niches: [], genres: [] });
    expect(out).toContain('whichever space the user is exploring');
    expect(out).toContain('across a flexible range of styles');
  });

  it('falls back to neutral phrasing when pillars/styles are omitted entirely', () => {
    const out = buildDefaultAgentPrompt();
    expect(out).toContain('whichever space the user is exploring');
    expect(out).toContain('across a flexible range of styles');
  });

  it('does NOT mention the franchise names that the old hardcoded prompt named', () => {
    const out = buildDefaultAgentPrompt({
      niches: ['Mythic Legends'],
      genres: ['Cinematic Crossovers'],
    });
    // The old prompt forced these into every reset; the new template
    // must let the user's actual focus tags speak for themselves.
    expect(out).not.toMatch(/Marvel,\s*DC,\s*Star Wars/i);
    expect(out).not.toMatch(/Warhammer 40k/i);
  });

  it('AI-ROLE-REDESIGN: opens with the MashupForge AI persona, drops "prompt generator" framing', () => {
    const out = buildDefaultAgentPrompt({ niches: ['X'], genres: ['Y'] });
    expect(out).toMatch(/MashupForge AI/);
    expect(out).toMatch(/co-pilot/i);
    expect(out).not.toMatch(/prompt generator/i);
    expect(out).not.toMatch(/Master Content Creator and Social Media Growth Strategist/);
  });

  it('AI-ROLE-REDESIGN: uses Content Pillars / Style Tags vocabulary, not Active Niches / Active Genres', () => {
    const out = buildDefaultAgentPrompt({ niches: ['X'], genres: ['Y'] });
    expect(out).toMatch(/Content Pillars/);
    expect(out).toMatch(/Style Tags/);
    expect(out).not.toMatch(/Active Niches and Active Genres/);
  });

  it('exports the curated default tag lists for the SettingsModal reset', () => {
    expect(DEFAULT_NICHES.length).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_GENRES.length).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_NICHES).toContain('Multiverse Crossovers');
    expect(DEFAULT_GENRES).toContain('Cinematic Crossovers');
  });
});
