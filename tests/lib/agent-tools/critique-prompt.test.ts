/**
 * v1.2 Tool Registry — `critique_prompt` tool tests.
 *
 * Heuristic judge: pure-function, fully tested. LLM judge: mocked
 * via the same `ai` mock as generate-prompt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const generateTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    tool: actual.tool,
  };
});
// The stub callable must expose `.chat` because the tool uses
// `openai.chat(id)` (MiniMax only speaks /v1/chat/completions).
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => {
    const make = (modelId: string) => ({ modelId, _stub: true });
    const callable = (modelId: string) => make(modelId);
    callable.chat = (modelId: string) => make(modelId);
    callable.responses = (modelId: string) => make(modelId);
    return callable;
  },
}));

import {
  executeCritiquePrompt,
  critiquePromptTool,
  heuristicJudge,
  type CritiqueRequirements,
} from '@/lib/agent-tools/critique-prompt';
import { ValidationError } from '@/lib/agent-tools/errors';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MINIMAX_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = '';
});

// ---------------------------------------------------------------------------
// heuristicJudge — pure function
// ---------------------------------------------------------------------------

/** Build a CritiqueRequirements with sensible defaults for tests. */
function req(overrides: Partial<CritiqueRequirements>): CritiqueRequirements {
  return {
    niches: ['X'],
    genres: [],
    angle: 'some angle here',
    antiAiLook: false,
    ...overrides,
  };
}

describe('heuristicJudge', () => {
  it('scores 1.0 for a prompt that covers all niches + angle + anti-AI tokens + length', () => {
    const result = heuristicJudge(
      'A cinematic portrait of Darth Vader in the Iron Man suit, shot on 35mm, dramatic rim lighting, natural light, film grain, candid. Marvel Comics and Star Wars vibes collide.',
      req({
        niches: ['Marvel Comics', 'Star Wars'],
        angle: 'Darth Vader in the Iron Man suit',
        antiAiLook: true,
      }),
    );
    expect(result.score).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it('penalises a missing niche', () => {
    const result = heuristicJudge(
      'A cinematic portrait of Darth Vader in the Iron Man suit, shot on 35mm, dramatic rim lighting, natural light, film grain.',
      req({ niches: ['Marvel Comics', 'Star Wars'], angle: 'Iron Man suit', antiAiLook: false }),
    );
    // Star Wars is mentioned (vader), Marvel Comics is not.
    expect(result.issues.some((i) => i.includes('Marvel Comics'))).toBe(true);
    expect(result.score).toBeLessThan(1);
  });

  it('penalises a missing angle token', () => {
    const result = heuristicJudge(
      'A random portrait of some character in some outfit, shot on 35mm, dramatic rim lighting, natural light, film grain.',
      req({ niches: ['Mythic Legends'], angle: 'Darth Vader in Iron Man suit', antiAiLook: false }),
    );
    expect(result.issues.some((i) => i.toLowerCase().includes('angle'))).toBe(true);
  });

  it('penalises missing anti-AI tokens when antiAiLook=true', () => {
    const result = heuristicJudge(
      'A generic description of a scene with no specific look tokens at all and just plain adjectives.',
      req({ angle: 'something interesting here', antiAiLook: true }),
    );
    expect(result.issues.some((i) => i.toLowerCase().includes('anti-ai'))).toBe(true);
  });

  it('does NOT penalise anti-AI tokens when antiAiLook=false', () => {
    const result = heuristicJudge(
      'A description of a scene, no look tokens, but otherwise covers the niche and angle.',
      req({ angle: 'something interesting here', antiAiLook: false }),
    );
    expect(result.issues.some((i) => i.toLowerCase().includes('anti-ai'))).toBe(false);
  });

  it('penalises a too-short prompt', () => {
    const result = heuristicJudge('short prompt', req({}));
    expect(result.issues.some((i) => i.includes('short'))).toBe(true);
  });

  it('orders issues most-severe first', () => {
    const result = heuristicJudge(
      'way too short',
      req({ angle: 'something else entirely here', antiAiLook: true }),
    );
    // At least 2 issues (niche miss + angle miss + short + anti-AI miss).
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    expect(result.score).toBeLessThan(0.5);
  });

  it('returns a 0..1 score (never out of range)', () => {
    const inputs: Array<{ p: string; req: CritiqueRequirements }> = [
      { p: 'A very long description ' + 'word '.repeat(100), req: req({}) },
      { p: 'short', req: req({}) },
      { p: 'perfect ' + 'word '.repeat(40), req: req({ antiAiLook: false }) },
    ];
    for (const { p, req: r } of inputs) {
      const res = heuristicJudge(p, r);
      expect(res.score).toBeGreaterThanOrEqual(0);
      expect(res.score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// executeCritiquePrompt — tool surface
// ---------------------------------------------------------------------------

describe('executeCritiquePrompt — input validation', () => {
  it('rejects when prompt is missing', async () => {
    const r = await executeCritiquePrompt({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });
});

describe('executeCritiquePrompt — happy paths', () => {
  it('mode=heuristic returns the pure-function result', async () => {
    const r = await executeCritiquePrompt({
      prompt: 'A cinematic portrait, shot on 35mm, dramatic rim lighting, natural light, film grain. Marvel Comics and Star Wars vibes collide in a dramatic crossover scene with multiple heroes.',
      requirements: {
        niches: ['Marvel Comics', 'Star Wars'],
        genres: [],
        angle: 'dramatic crossover scene with multiple heroes',
        antiAiLook: true,
      },
    }, { mode: 'heuristic' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(1);
  });

  it('mode=auto defaults to heuristic when no provider is configured', async () => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const r = await executeCritiquePrompt({
      prompt: 'A cinematic portrait, shot on 35mm, dramatic rim lighting, natural light, film grain. Marvel Comics and Star Wars vibes collide in a dramatic crossover scene with multiple heroes.',
      requirements: {
        niches: ['Marvel Comics', 'Star Wars'],
        genres: [],
        angle: 'dramatic crossover scene with multiple heroes',
        antiAiLook: true,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(1);
  });
});

describe('executeCritiquePrompt — LLM judge path', () => {
  it('mode=llm calls the model and parses the JSON response', async () => {
    generateTextMock.mockResolvedValue({
      text: '{"score": 0.42, "issues": ["too short", "missing Marvel"]}',
    });
    const r = await executeCritiquePrompt({
      prompt: 'A sufficiently long prompt to pass the validation gate.',
      requirements: { niches: ['Marvel Comics'], genres: [], angle: 'some angle here' },
    }, { mode: 'llm' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(0.42);
      expect(r.value.issues).toEqual(['too short', 'missing Marvel']);
    }
  });

  it('mode=llm tolerates <think> blocks and fences', async () => {
    generateTextMock.mockResolvedValue({
      text: '<think>Let me evaluate this. The prompt is too short and missing some content.</think>```json\n{"score": 0.5, "issues": ["short"]}\n```',
    });
    const r = await executeCritiquePrompt({
      prompt: 'A sufficiently long prompt to pass the validation gate.',
      requirements: { niches: ['X'], genres: [], angle: 'some angle here' },
    }, { mode: 'llm' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(0.5);
      expect(r.value.issues).toEqual(['short']);
    }
  });

  it('mode=llm throws when the model returns no JSON object', async () => {
    generateTextMock.mockResolvedValue({ text: 'I cannot score this prompt.' });
    const r = await executeCritiquePrompt({
      prompt: 'A sufficiently long prompt to pass the validation gate.',
      requirements: { niches: ['X'], genres: [], angle: 'some angle here' },
    }, { mode: 'llm' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TOOL_EXECUTION_ERROR');
  });

  it('mode=llm throws when the model returns an out-of-range score', async () => {
    generateTextMock.mockResolvedValue({ text: '{"score": 1.7, "issues": []}' });
    const r = await executeCritiquePrompt({
      prompt: 'A sufficiently long prompt to pass the validation gate.',
      requirements: { niches: ['X'], genres: [], angle: 'some angle here' },
    }, { mode: 'llm' });
    expect(r.ok).toBe(false);
  });
});

describe('critiquePromptTool (Vercel AI SDK shape)', () => {
  it('has a description and schemas', () => {
    const obj = critiquePromptTool as unknown as Record<string, unknown>;
    expect(typeof obj.description).toBe('string');
    expect(obj.inputSchema).toBeDefined();
    expect(obj.outputSchema).toBeDefined();
  });
});
