/**
 * AGENT.md loader tests.
 *
 * The chat/stream path is driven by the repo-root AGENT.md file. These tests
 * pin: (1) the real file loads and carries the agent's identity, (2) the loader
 * caches, (3) the embedded fallback is a faithful mirror used when the file
 * can't be read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadAgentInstructions,
  __resetAgentInstructionsCache,
  AGENT_MD_EMBEDDED_FALLBACK,
} from '@/lib/agent-loop/agent-md';

beforeEach(() => {
  __resetAgentInstructionsCache();
});

describe('loadAgentInstructions', () => {
  it('loads the repo-root AGENT.md and carries the agent identity', async () => {
    const text = await loadAgentInstructions();
    expect(text.length).toBeGreaterThan(0);
    // IDENTITY: the AIart4never Studio agent for the ORIGINAL Master4never IP.
    expect(text).toMatch(/AIart4never Studio agent/i);
    expect(text).toMatch(/Master4never/);
    expect(text).toMatch(/Kael/);
    // Free-to-think / gated-to-act framing.
    expect(text).toMatch(/approval queue/i);
    // Tools are named so the agent knows its capabilities.
    expect(text).toMatch(/generate_image/);
    // Story 2.8: canon is resolved LIVE from Higgsfield via the read-only lookup.
    expect(text).toMatch(/show_reference_elements/);
    // The resolve-first hard gate (ordered step 1) + the fail-safe on ambiguity/absence.
    expect(text).toMatch(/resolve the element first/i);
    expect(text).toMatch(/ask the operator/i);
    // Original-IP-only guardrail.
    expect(text).toMatch(/Original IP only/i);
  });

  it('does NOT embed the rigid 6-step director scaffold', async () => {
    const text = await loadAgentInstructions();
    expect(text).not.toMatch(/Director plan \(executed in this order/i);
    expect(text).not.toMatch(/Execute the director plan/i);
  });

  it('caches the result across calls (same reference content)', async () => {
    const a = await loadAgentInstructions();
    const b = await loadAgentInstructions();
    expect(a).toBe(b);
  });

  it('exposes a faithful embedded fallback mirroring the identity', () => {
    expect(AGENT_MD_EMBEDDED_FALLBACK).toMatch(/AIart4never Studio agent/i);
    expect(AGENT_MD_EMBEDDED_FALLBACK).toMatch(/Master4never/);
    expect(AGENT_MD_EMBEDDED_FALLBACK).toMatch(/generate_image/);
    expect(AGENT_MD_EMBEDDED_FALLBACK).toMatch(/show_reference_elements/);
    expect(AGENT_MD_EMBEDDED_FALLBACK).toMatch(/approval queue/i);
    // No rigid scaffold in the fallback either.
    expect(AGENT_MD_EMBEDDED_FALLBACK).not.toMatch(/Execute the director plan/i);
  });
});
