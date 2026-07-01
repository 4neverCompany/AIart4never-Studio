/**
 * Story 10.3: the legacy brief-based director paths (handleDirectorMode JSON
 * envelope + handleDirectorStream, both driven by runDirectorLoop) were retired.
 * The route now serves ONLY the conversational agent (stream:true + agentCore:true
 * + messages -> handleAgentStream). A stale brief-shaped request must fail CLEAR
 * with a 400 — NOT silently fall through to a removed loop (AC2 / FR-1 / PRD §5).
 *
 * These cases hit the rejection BEFORE any lazy loop import, so no `ai`/runAgent
 * mock is needed; the live agent path stays covered by ai-prompt-agent-core.test.ts.
 */
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { POST as promptPost } from '@/app/api/ai/prompt/route';

function makePost(body: unknown): Request {
  return new Request('http://x/api/ai/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/ai/prompt — legacy director paths retired (Story 10.3)', () => {
  it('rejects the legacy JSON brief shape (ideaConcept/niches, no agentCore) with a clear 400', async () => {
    const res = await promptPost(
      makePost({ mode: 'director', ideaConcept: 'Kael in a storm-wreathed sky-temple', niches: ['Mythic Legends'] }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/agentCore|retired|legacy/i);
  });

  it('rejects a legacy STREAM brief (stream:true, no agentCore) with 400 — no SSE fall-through to runDirectorLoop', async () => {
    const res = await promptPost(
      makePost({ mode: 'director', stream: true, ideaConcept: 'x', niches: ['y'] }),
    );
    expect(res.status).toBe(400);
    // A JSON error, NOT a text/event-stream — proves it did not enter a stream handler.
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  it('rejects a bare director request (no stream, no agentCore) with 400', async () => {
    const res = await promptPost(makePost({ mode: 'director' }));
    expect(res.status).toBe(400);
  });
});
