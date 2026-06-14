/**
 * v1.2.3 — Eval heuristic: niche coverage.
 *
 * Measures what fraction of the user's requested niches appear
 * in the generated prompt. A 5-niche brief where only 2 are
 * mentioned scores 0.4 — the eval will mark the prompt
 * "incomplete" and trigger a refine pass.
 *
 * Matching is case-insensitive and substring-based
 * (`prompt.toLowerCase().includes(niche.toLowerCase())`).
 * A niche with a 1-char typo would not match, but the
 * frontier-model output is generally close-enough to
 * the brief that this isn't a real-world problem. v1.3 can
 * upgrade to fuzzy matching if needed.
 *
 * Pure function, no IO. Snapshot-tested in `aggregate.test.ts`.
 */

export interface NicheCoverageResult {
  /** 0..1 fraction of niches present in the prompt. */
  score: number;
  /** Niches that the prompt covers. */
  present: string[];
  /** Niches that the prompt is missing. */
  missing: string[];
  /** Original input sizes for downstream debugging. */
  totalNiches: number;
}

export function evalNicheCoverage(
  prompt: string,
  niches: readonly string[],
): NicheCoverageResult {
  if (niches.length === 0) {
    return { score: 1, present: [], missing: [], totalNiches: 0 };
  }
  const lowered = prompt.toLowerCase();
  const present: string[] = [];
  const missing: string[] = [];
  for (const niche of niches) {
    const n = niche.trim();
    if (n.length === 0) {
      missing.push(niche);
      continue;
    }
    if (lowered.includes(n.toLowerCase())) {
      present.push(n);
    } else {
      missing.push(n);
    }
  }
  const score = present.length / niches.length;
  return { score, present, missing, totalNiches: niches.length };
}
