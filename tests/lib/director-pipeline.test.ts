/**
 * V1.6: requestDirectorPrompt — the agentic Director pipeline's (the
 * default idea→prompt path since v1.6.0; opt-in in v1.5.0) network call
 * + graceful fallback. Tests the contract that the pipeline relies on:
 * a usable prompt on success, and a never-throwing `{ ok:false, reason }`
 * on every failure — including implausible "prompts" (apology text,
 * failure sentinels, runaways) — so the caller can fall back to the
 * verbatim concept.
 */
import { describe, it, expect, vi } from 'vitest';
import { requestDirectorPrompt, checkPromptPlausibility } from '@/lib/director-pipeline';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const base = {
  ideaConcept: 'Darth Vader in an Iron Man suit',
  niches: ['Multiverse Crossovers'],
  genres: ['Noir & Gritty'],
};

// A realistic Director output (≥15 words) — the V1.6 plausibility gate
// rejects implausibly short "prompts", so test fixtures must look real.
const GOOD_PROMPT =
  'A long, cinematic crossover prompt: Darth Vader stands in a rain-slicked neon Tokyo alley wearing '
  + 'a battle-scarred Iron Man suit, volumetric red rim lighting, low-angle 35mm shot, hyperdetailed, dramatic atmosphere.';

describe('requestDirectorPrompt', () => {
  it('returns the Director prompt on success and posts mode:director', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ prompt: GOOD_PROMPT, cost: 0.0123, truncatedBy: 'natural' }),
    );
    const out = await requestDirectorPrompt(base, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.prompt).toContain('cinematic crossover');
      expect(out.cost).toBe(0.0123);
      expect(out.truncatedBy).toBe('natural');
    }
    // Verify the request shape the Director route expects.
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.mode).toBe('director');
    expect(body.niches).toEqual(['Multiverse Crossovers']);
    expect(url).toBe('/api/ai/prompt');
  });

  it('falls back (ok:false) with no content pillars — never calls the route', async () => {
    const fetchImpl = vi.fn();
    const out = await requestDirectorPrompt({ ...base, niches: [] }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/content pillar/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back on a too-short concept without calling the route', async () => {
    const fetchImpl = vi.fn();
    const out = await requestDirectorPrompt({ ...base, ideaConcept: 'hi' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back with the route error message on a 503 (no provider configured)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'No AI provider configured.' }, false, 503));
    const out = await requestDirectorPrompt(base, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/no ai provider/i);
  });

  it('falls back on an empty prompt', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt: '   ' }));
    const out = await requestDirectorPrompt(base, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/empty/i);
  });

  it('falls back (never throws) on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    const out = await requestDirectorPrompt(base, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/failed to fetch/i);
  });

  it('caps niches to 6 and genres to 10', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt: GOOD_PROMPT }));
    await requestDirectorPrompt(
      {
        ideaConcept: 'concept long enough',
        niches: Array.from({ length: 9 }, (_, i) => `n${i}`),
        genres: Array.from({ length: 14 }, (_, i) => `g${i}`),
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.niches).toHaveLength(6);
    expect(body.genres).toHaveLength(10);
  });

  it('clamps each niche/genre to 80 chars (the agent loop Zod limit)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt: GOOD_PROMPT }));
    await requestDirectorPrompt(
      {
        ideaConcept: 'concept long enough',
        niches: ['x'.repeat(200)],
        genres: ['y'.repeat(200)],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.niches[0]).toHaveLength(80);
    expect(body.genres[0]).toHaveLength(80);
  });

  // V1.6 plausibility gate — a 200 whose "prompt" is not a usable image
  // prompt must NOT reach image generation (it would spend credits on a
  // failure explanation). Reachable because the Director's system prompt
  // tells the model to surface unrecoverable failures in the final text.
  it('falls back when the 200 prompt is a failure explanation (apology text)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        prompt:
          'I could not complete the prompt draft because the trending search tool failed twice in a row and no usable context was available for this concept.',
        truncatedBy: 'natural',
      }),
    );
    const out = await requestDirectorPrompt(base, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/failure explanation/i);
  });

  it('falls back on the DIRECTOR_FAILED sentinel', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ prompt: 'DIRECTOR_FAILED: trending_search unavailable after two attempts.' }),
    );
    const out = await requestDirectorPrompt(base, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/director reported failure/i);
  });

  it('falls back when truncatedBy is error even with non-empty text', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ prompt: GOOD_PROMPT, truncatedBy: 'error' }),
    );
    const out = await requestDirectorPrompt(base, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/errored/i);
  });

  it('falls back on implausibly short and runaway-long prompts', async () => {
    const short = vi.fn(async () => jsonResponse({ prompt: 'Too short.' }));
    const outShort = await requestDirectorPrompt(base, { fetchImpl: short as unknown as typeof fetch });
    expect(outShort.ok).toBe(false);

    const long = vi.fn(async () => jsonResponse({ prompt: Array(450).fill('word').join(' ') }));
    const outLong = await requestDirectorPrompt(base, { fetchImpl: long as unknown as typeof fetch });
    expect(outLong.ok).toBe(false);
  });
});

describe('checkPromptPlausibility', () => {
  it('accepts a realistic 40-150 word prompt', () => {
    expect(checkPromptPlausibility(GOOD_PROMPT, 'natural')).toBeNull();
  });

  it('accepts budget-truncated text that still looks like a prompt', () => {
    // 'budget' alone is not a rejection signal — the loop may have
    // produced a perfectly usable draft before the cap fired.
    expect(checkPromptPlausibility(GOOD_PROMPT, 'budget')).toBeNull();
  });

  it('rejects first-person failure openers case-insensitively', () => {
    const apology =
      "Sorry, the generate_prompt tool kept failing so there is no draft available for this concept and you should retry later with a different angle or model.";
    expect(checkPromptPlausibility(apology, undefined)).toMatch(/failure explanation/i);
  });

  it('rejects reasoning/commentary that slipped past the extractor (V1.8.1)', () => {
    const commentary =
      'The checker is strict about literal keyword matches. Let me build a final draft that explicitly weaves in the niche vocabulary and required anti-AI-look tokens for this concept.';
    expect(checkPromptPlausibility(commentary, 'natural')).toMatch(/commentary|reasoning/i);
  });
});
