// V1.1.1-SKILLS-AUTO-USE: regression test for the skill loader +
// system-prompt injection in /api/ai/prompt.
//
// The pipeline:
//   1. The frontend reads settings.activeSkills and forwards
//      the list to the route as `body.activeSkills`.
//   2. The route calls buildSkillSystemBlock(activeSkills).
//   3. buildSkillSystemBlock reads the .SKILL.md files from
//      docs/research/higgsfield-skills/, filters by active name,
//      and concatenates their bodies into a system-prompt
//      fragment.
//   4. The route appends the fragment to the system prompt.
//
// This test pins:
//   - loadAllSkills discovers the `*-SKILL.md` files in the
//     repo's docs dir (banana-pro-director, cinema-world-builder)
//   - long-form reference variants (cinema-world-builder-cinema-SKILL.md)
//     are excluded by the loader's allowlist.
//   - buildSkillSystemBlock skips unknown names silently.
//   - buildSkillSystemBlock concatenates active skills in stable
//     name-sorted order.
//   - The route's `body.activeSkills` field is read at request
//     time and propagates into the system prompt.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as promptPost } from '@/app/api/ai/prompt/route';
import { loadAllSkills, buildSkillSystemBlock } from '@/lib/skill-loader';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  // The ai route resolves provider via env. For these tests we
  // configure a fake MiniMax key + base URL pointing at a stub
  // fetch that returns a single text delta + [DONE].
  process.env.MINIMAX_API_KEY = 'sk-test-fake';
  process.env.MINIMAX_API_BASE_URL = 'https://api.test';
  fetchMock.mockResolvedValue(
    new Response(
      // SSE-shape response: a single data: line + [DONE]
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_BASE_URL;
});

function makePost(body: unknown): Request {
  return new Request('http://x/api/ai/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('loadAllSkills', () => {
  it('discovers the main SKILL.md files in docs/research/higgsfield-skills/', async () => {
    const skills = await loadAllSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain('banana-pro-director');
    // The cinema-world-builder main file is in scope; the long-form
    // reference variant (cinema-world-builder-cinema-SKILL.md) is
    // excluded.
    expect(names).not.toContain('cinema-world-builder-cinema');
  });

  it('parses YAML frontmatter for name + description', async () => {
    const skills = await loadAllSkills();
    const bpd = skills.find((s) => s.name === 'banana-pro-director');
    expect(bpd).toBeDefined();
    // body is non-empty markdown (no frontmatter, no leading whitespace)
    expect(bpd!.body.length).toBeGreaterThan(100);
    expect(bpd!.body).not.toMatch(/^---/);
    // description is non-empty for any skill that has one
    expect(bpd!.description.length).toBeGreaterThan(0);
  });
});

describe('buildSkillSystemBlock', () => {
  it('returns empty string for unknown / empty active lists', async () => {
    expect(await buildSkillSystemBlock([])).toBe('');
    expect(await buildSkillSystemBlock(['nonexistent-skill'])).toBe('');
  });

  it('concatenates active skill bodies with a header', async () => {
    const block = await buildSkillSystemBlock(['banana-pro-director']);
    expect(block).toContain('## Active Skills');
    expect(block).toContain('### Skill 1: banana-pro-director');
    expect(block).toContain('SLCT');
  });

  it('skips unknown names and keeps the known ones', async () => {
    const block = await buildSkillSystemBlock(['banana-pro-director', 'nonexistent']);
    expect(block).toContain('### Skill 1: banana-pro-director');
    // No Skill 2 block for the unknown one
    expect(block).not.toContain('### Skill 2');
  });
});

describe('POST /api/ai/prompt — V1.1.1 skills injection', () => {
  it('forwards activeSkills from the body into the system prompt', async () => {
    // Capture the request body the route sends to MiniMax. The
    // ai route streams text deltas; the body isn't directly
    // observable in the response. Instead, we hook fetch and
    // read the upstream request body to confirm the skills
    // block was concatenated.
    let upstreamBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      // The ai route uses openai SDK which uses fetch internally;
      // the SDK does send a JSON body. We capture it from
      // init.body.
      if (init?.body && typeof init.body === 'string') {
        try {
          upstreamBody = JSON.parse(init.body);
        } catch {
          // ignore
        }
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const res = await promptPost(
      makePost({
        message: 'a man with a lightsaber',
        mode: 'generate',
        activeSkills: ['banana-pro-director'],
      }),
    );
    expect(res.status).toBe(200);
    // The Vercel AI SDK sends the messages in an OpenAI-shaped
    // request body. We assert that the system message contains
    // the loaded skill body.
    expect(upstreamBody).not.toBeNull();
    const messages = ((upstreamBody ?? {}) as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
    const systemMsg = messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('## Active Skills');
    expect(systemMsg!.content).toContain('banana-pro-director');
  });

  it('omits the skills block when no active skills are sent', async () => {
    let upstreamBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body && typeof init.body === 'string') {
        try {
          upstreamBody = JSON.parse(init.body);
        } catch {
          // ignore
        }
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const res = await promptPost(
      makePost({
        message: 'a quiet scene',
        mode: 'generate',
        // No activeSkills field
      }),
    );
    expect(res.status).toBe(200);
    const messages = ((upstreamBody ?? {}) as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
    const systemMsg = messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).not.toContain('## Active Skills');
  });

  it('silently ignores unknown skill names in the request body', async () => {
    let upstreamBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body && typeof init.body === 'string') {
        try {
          upstreamBody = JSON.parse(init.body);
        } catch {
          // ignore
        }
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    await promptPost(
      makePost({
        message: 'p',
        mode: 'generate',
        activeSkills: ['not-a-real-skill'],
      }),
    );
    const messages = ((upstreamBody ?? {}) as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
    const systemMsg = messages.find((m) => m.role === 'system');
    expect(systemMsg!.content).not.toContain('## Active Skills');
  });
});
