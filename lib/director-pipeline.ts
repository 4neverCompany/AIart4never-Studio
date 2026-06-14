/**
 * V1.6: agentic Director pipeline (shipped opt-in in v1.5.0; the DEFAULT
 * idea→prompt path since v1.6.0 — switch off in Settings → AI Engine) —
 * the network call that turns an idea concept into a planned image
 * prompt via the multi-step tool-use loop (`/api/ai/prompt`
 * mode:director → lib/agent-loop).
 *
 * Extracted from hooks/useIdeaProcessor.ts so the request + fallback logic
 * is unit-testable without rendering the pipeline hook. The function NEVER
 * throws and NEVER blocks the pipeline: any failure (no provider, route
 * 4xx, empty/implausible prompt, network error) resolves to
 * `{ ok: false, reason }` and the caller falls back to the verbatim
 * concept.
 */

export interface DirectorPromptRequest {
  /** The idea concept (the "angle"). Trimmed + capped to 400 chars here. */
  ideaConcept: string;
  /** 1-6 content pillars. The Director route 400s on an empty list. */
  niches: string[];
  /** 0-10 style tags. */
  genres: string[];
  /** Optional text-AI model id (falls back to the server default). */
  model?: string;
  /** Active skill names folded into the prompt template. */
  activeSkills?: string[];
}

export type DirectorPromptOutcome =
  | { ok: true; prompt: string; cost?: number; truncatedBy?: string }
  | { ok: false; reason: string };

/**
 * V1.6: shape check for the Director's final text. Returns a rejection
 * reason when the text is NOT a usable image prompt, null when it is.
 * Exported for unit tests.
 *
 * Signals, cheapest first:
 *  - the machine-detectable failure sentinel (lib/agent-loop/plan.ts
 *    instructs the model to finalize unrecoverable failures with
 *    "DIRECTOR_FAILED: <reason>");
 *  - truncatedBy 'error' (the loop caught a thrown error mid-run; any
 *    best-effort text is unreviewed salvage, not a finished prompt);
 *  - word count outside 15–400 (the Director's own critique heuristic
 *    targets 40–150 words; mid-thought budget stubs and runaways fall
 *    far outside this generous band);
 *  - first-person failure openers ("I couldn't…", "Sorry, …") — a real
 *    image prompt never starts in the first person.
 */
export function checkPromptPlausibility(
  prompt: string,
  truncatedBy: string | undefined,
): string | null {
  if (/^DIRECTOR_FAILED\b/i.test(prompt)) {
    return `director reported failure: ${prompt.slice(0, 160)}`;
  }
  if (truncatedBy === 'error') {
    return 'director run errored before finishing';
  }
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (words < 15) return `implausible prompt (only ${words} words)`;
  if (words > 400) return `implausible prompt (${words} words — runaway)`;
  if (
    /^(i\s+(could\s*not|couldn'?t|was\s+unable|am\s+unable|cannot|can'?t|apologi[sz]e)|sorry\b|unfortunately\b|unable\s+to\b)/i.test(
      prompt,
    )
  ) {
    return 'director returned a failure explanation instead of a prompt';
  }
  // V1.8.1-COMMENTARY-LEAK: last line of defense against the model's
  // reasoning/meta-narration reaching the image generator (the
  // credit-burning off-topic images Maurice reported). The server-side
  // extractor (prompt-extract.ts) is the primary guard; this client
  // gate catches anything that slips through a future regression. A
  // genuine image prompt never talks ABOUT building a prompt.
  if (
    /\b(the\s+checker|let\s+me\s+(build|draft|think|write)|niches?\s+anchored|ready\s+to\s+feed|anti-?ai-?look\s+tokens?|copy-?paste\s+ready|final\s+(draft|prompt)\s*\(|weaves?\s+in\s+the\s+niche)\b/i.test(
      prompt,
    )
  ) {
    return 'director returned commentary/reasoning instead of a prompt';
  }
  return null;
}

/**
 * POST the Director request and return the final prompt, or a reason to
 * fall back. `fetchImpl` is injectable for tests.
 */
export async function requestDirectorPrompt(
  req: DirectorPromptRequest,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<DirectorPromptOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  // V1.6: clamp per-item length to the agent loop's 80-char Zod limit
  // (mirrors the 400-char concept clamp below). Without this, a single
  // long Content Pillar made EVERY Director call 500 with a cryptic
  // per-idea Zod message under the new default. Truncation is safe —
  // the strings only seed the Director's orientation prompt.
  const niches = req.niches.filter(Boolean).map((s) => s.trim().slice(0, 80)).slice(0, 6);
  if (niches.length === 0) {
    return { ok: false, reason: 'no content pillars configured' };
  }
  const concept = req.ideaConcept.trim().slice(0, 400);
  if (concept.length < 3) {
    return { ok: false, reason: 'concept too short' };
  }

  try {
    const res = await doFetch('/api/ai/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'director',
        ideaConcept: concept,
        niches,
        genres: req.genres.filter(Boolean).map((s) => s.trim().slice(0, 80)).slice(0, 10),
        ...(req.model ? { model: req.model } : {}),
        skillContext: (req.activeSkills ?? []).filter(Boolean).map((name) => ({ name })),
        userId: 'pipeline',
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try {
        const e = (await res.json()) as { error?: string };
        if (e.error) reason = e.error;
      } catch {
        /* non-JSON error body — keep the status string */
      }
      return { ok: false, reason };
    }

    const data = (await res.json()) as { prompt?: string; cost?: number; truncatedBy?: string };
    const prompt = (data.prompt ?? '').trim();
    if (prompt.length === 0) {
      return { ok: false, reason: 'empty prompt' };
    }
    // V1.6 plausibility gate: the Director's system prompt tells the
    // model to "surface the issue in the final text and finalize" when
    // tools fail repeatedly — so a failed run can come back as a 200
    // whose "prompt" is an apology/explanation. Before the gate, that
    // text went straight into image generation, spending image credits
    // on a failure message. Reject anything that doesn't look like a
    // usable image prompt; the caller falls back to the verbatim
    // concept (which is what these users got pre-v1.6 anyway).
    const implausible = checkPromptPlausibility(prompt, data.truncatedBy);
    if (implausible) {
      return { ok: false, reason: implausible };
    }
    return {
      ok: true,
      prompt,
      ...(typeof data.cost === 'number' ? { cost: data.cost } : {}),
      ...(typeof data.truncatedBy === 'string' ? { truncatedBy: data.truncatedBy } : {}),
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'network error' };
  }
}
