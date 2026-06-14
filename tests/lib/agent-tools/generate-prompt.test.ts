/**
 * v1.2 Tool Registry — `generate_prompt` tool tests.
 *
 * The tool's execute() calls `generateText` from the Vercel AI SDK
 * with a MiniMax model. We mock the SDK so tests run offline and
 * can assert on the prompt the model would see.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the call args for inspection.
const generateTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    tool: actual.tool,
  };
});

// Mock the OpenAI adapter so we don't try to instantiate a real client.
// The real `createOpenAI()` returns a callable that ALSO carries
// transport methods (`.chat`, `.responses`, …). The Director tools use
// `openai.chat(id)` (MiniMax only speaks /v1/chat/completions), so the
// stub must expose `.chat` too.
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
  executeGeneratePrompt,
  generatePromptTool,
} from '@/lib/agent-tools/generate-prompt';
import { ValidationError, ToolNotAvailableError } from '@/lib/agent-tools/errors';

beforeEach(() => {
  vi.clearAllMocks();
  // Pretend MiniMax is configured by default for these tests.
  process.env.MINIMAX_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = '';
});

describe('executeGeneratePrompt — input validation', () => {
  it('rejects when niches is missing', async () => {
    const r = await executeGeneratePrompt({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('rejects when genres is missing', async () => {
    const r = await executeGeneratePrompt({ niches: ['X'], angle: 'y' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an angle shorter than 3 chars', async () => {
    const r = await executeGeneratePrompt({
      niches: ['X'],
      genres: ['Y'],
      angle: 'no',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });
});

describe('executeGeneratePrompt — provider resolution', () => {
  it('throws ToolNotAvailableError when no AI provider is configured', async () => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const r = await executeGeneratePrompt({
      niches: ['X'],
      genres: ['Y'],
      angle: 'some angle here',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });

  it('prefers MiniMax over OpenAI when both are configured', async () => {
    process.env.MINIMAX_API_KEY = 'm';
    process.env.OPENAI_API_KEY = 'o';
    generateTextMock.mockResolvedValue({ text: 'A draft prompt of sufficient length to pass the validation gate.' });
    const r = await executeGeneratePrompt({
      niches: ['Mythic Legends'],
      genres: ['Cinematic Crossovers'],
      angle: 'Darth Vader as Iron Man',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.modelId).toBe('MiniMax-M3');
  });

  it('falls back to OpenAI when only OpenAI is configured', async () => {
    delete process.env.MINIMAX_API_KEY;
    process.env.OPENAI_API_KEY = 'o';
    generateTextMock.mockResolvedValue({ text: 'A draft prompt of sufficient length to pass the validation gate.' });
    const r = await executeGeneratePrompt({
      niches: ['Mythic Legends'],
      genres: ['Cinematic Crossovers'],
      angle: 'Darth Vader as Iron Man',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.modelId).toBe('gpt-4o-mini');
  });
});

describe('executeGeneratePrompt — happy path', () => {
  it('returns the cleaned draft + modelId', async () => {
    generateTextMock.mockResolvedValue({
      text: 'A cinematic portrait of Darth Vader in the Iron Man suit, dramatic rim lighting, 35mm film grain.',
    });
    const r = await executeGeneratePrompt({
      niches: ['Mythic Legends'],
      genres: ['Cinematic Crossovers'],
      angle: 'Darth Vader as Iron Man',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.draft).toContain('Darth Vader');
      expect(r.value.modelId).toBe('MiniMax-M3');
      expect(r.value.usedSkills).toEqual([]);
    }
  });

  it('strips <think>…</think> reasoning blocks from the draft', async () => {
    generateTextMock.mockResolvedValue({
      text: '<think>Let me think about this. The user wants a Darth Vader Iron Man mashup, so I need to balance both vibes.</think>A cinematic portrait of Darth Vader in the Iron Man suit, dramatic rim lighting.',
    });
    const r = await executeGeneratePrompt({
      niches: ['Mythic Legends'],
      genres: ['Cinematic Crossovers'],
      angle: 'Darth Vader as Iron Man',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.draft).not.toContain('<think>');
      expect(r.value.draft).not.toContain('Let me think');
    }
  });

  it('strips markdown code fences', async () => {
    generateTextMock.mockResolvedValue({
      text: '```\nA cinematic portrait of Darth Vader in the Iron Man suit.\n```',
    });
    const r = await executeGeneratePrompt({
      niches: ['X'],
      genres: ['Y'],
      angle: 'some angle here',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.draft).not.toContain('```');
      expect(r.value.draft).toContain('cinematic');
    }
  });

  it('infers usedSkills when their name appears in the draft', async () => {
    generateTextMock.mockResolvedValue({
      text: 'A cinematic portrait, shot on 35mm, with deliberate film grain. References framing:camera-angles for the eye-level composition.',
    });
    const r = await executeGeneratePrompt({
      niches: ['X'],
      genres: ['Y'],
      angle: 'some angle here',
      skillContext: [
        { name: 'framing:camera-angles' },
        { name: 'voice:noir' },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.usedSkills).toContain('framing:camera-angles');
      // "voice:noir" doesn't appear in the draft → not used.
      expect(r.value.usedSkills).not.toContain('voice:noir');
    }
  });
});

describe('executeGeneratePrompt — error path', () => {
  it('wraps an SDK throw as a retryable ToolExecutionError', async () => {
    generateTextMock.mockRejectedValue(new Error('network down'));
    const r = await executeGeneratePrompt({
      niches: ['X'],
      genres: ['Y'],
      angle: 'some angle here',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Generated via safeExecute → AgentToolError directly.
      expect(r.error.code).toBe('TOOL_EXECUTION_ERROR');
    }
  });
});

describe('generatePromptTool (Vercel AI SDK shape)', () => {
  it('has a description and schemas', () => {
    const obj = generatePromptTool as unknown as Record<string, unknown>;
    expect(typeof obj.description).toBe('string');
    expect(obj.inputSchema).toBeDefined();
    expect(obj.outputSchema).toBeDefined();
  });
});
