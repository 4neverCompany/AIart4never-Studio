/**
 * Session-memory shim for the stateless pi.dev sidecar.
 *
 * pi is spawned with `--no-session`, so every call is stateless. We fake
 * memory by persisting a small bag of state on the client and re-injecting
 * it into the system prompt on every request (for the `idea` and `generate`
 * modes). The goal is coherence across a workflow session — not a true
 * long-term memory — so the on-disk footprint is intentionally tiny.
 *
 * Isomorphic: the pure helpers (format / compress / createEmptyMemory) run
 * anywhere; the localStorage getters/setters guard against the server env.
 */

export interface PipelineMemory {
  /** Recent crossover concepts user has explored. Bounded to last 10. */
  recentConcepts: string[];
  /** Styles that made it past review (posted, not skipped). Last 8 unique. */
  successfulStyles: string[];
  /** Negative-prompt terms tied to rejected outputs. Last 8 unique. */
  avoidedNegatives: string[];
  /** Running tally of how often each niche gets picked. */
  nicheWeights: Record<string, number>;
  /** Unix ms — refreshed on every write. */
  lastUpdated: number;
}

const STORAGE_KEY = 'mashup_pipeline_memory';
const MAX_RECENT_CONCEPTS = 10;
const MAX_SUCCESSFUL_STYLES = 8;
const MAX_AVOIDED_NEGATIVES = 8;
const MIN_NICHE_WEIGHT = 1;
const MAX_NICHES = 12;
const MAX_FORMATTED_WORDS = 300;

export function createEmptyMemory(): PipelineMemory {
  return {
    recentConcepts: [],
    successfulStyles: [],
    avoidedNegatives: [],
    nicheWeights: {},
    lastUpdated: 0,
  };
}

/**
 * Normalize a partial / unknown blob into a valid PipelineMemory. Used
 * when reading from localStorage so a corrupted key can't crash the app.
 */
export function coerceMemory(raw: unknown): PipelineMemory {
  const base = createEmptyMemory();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

  const weights: Record<string, number> = {};
  if (r.nicheWeights && typeof r.nicheWeights === 'object' && !Array.isArray(r.nicheWeights)) {
    for (const [k, v] of Object.entries(r.nicheWeights as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) weights[k] = v;
    }
  }

  return {
    recentConcepts: asStringArray(r.recentConcepts).slice(-MAX_RECENT_CONCEPTS),
    successfulStyles: asStringArray(r.successfulStyles).slice(-MAX_SUCCESSFUL_STYLES),
    avoidedNegatives: asStringArray(r.avoidedNegatives).slice(-MAX_AVOIDED_NEGATIVES),
    nicheWeights: weights,
    lastUpdated: typeof r.lastUpdated === 'number' && Number.isFinite(r.lastUpdated) ? r.lastUpdated : 0,
  };
}

export function getPipelineMemory(): PipelineMemory {
  if (typeof window === 'undefined') return createEmptyMemory();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyMemory();
    return coerceMemory(JSON.parse(raw));
  } catch {
    return createEmptyMemory();
  }
}

export function updatePipelineMemory(
  updater: (prev: PipelineMemory) => PipelineMemory,
): PipelineMemory {
  const prev = getPipelineMemory();
  const next = { ...updater(prev), lastUpdated: Date.now() };
  const compressed = compressMemory(next);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(compressed));
    } catch {
      /* quota / serialization failures are not fatal — memory is best-effort */
    }
  }
  return compressed;
}

/**
 * Keep the memory bounded. Preserves recency by slicing from the end of
 * each list and dropping niches with weight < 1 (or if we're over the cap,
 * keeping the top-weighted entries).
 */
export function compressMemory(memory: PipelineMemory): PipelineMemory {
  const dedupTail = (list: string[], cap: number) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = list.length - 1; i >= 0 && out.length < cap; i--) {
      const v = list[i];
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out.reverse();
  };

  const pruned: Record<string, number> = {};
  for (const [k, v] of Object.entries(memory.nicheWeights)) {
    if (v >= MIN_NICHE_WEIGHT) pruned[k] = v;
  }
  const nicheEntries = Object.entries(pruned)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_NICHES);

  return {
    recentConcepts: dedupTail(memory.recentConcepts, MAX_RECENT_CONCEPTS),
    successfulStyles: dedupTail(memory.successfulStyles, MAX_SUCCESSFUL_STYLES),
    avoidedNegatives: dedupTail(memory.avoidedNegatives, MAX_AVOIDED_NEGATIVES),
    nicheWeights: Object.fromEntries(nicheEntries),
    lastUpdated: memory.lastUpdated,
  };
}

function truncateWords(s: string, maxWords: number): string {
  const words = s.split(/\s+/);
  if (words.length <= maxWords) return s;
  return words.slice(0, maxWords).join(' ') + '…';
}

/**
 * Render memory as a `[SESSION MEMORY]` block for the system prompt.
 * Returns `''` when there's nothing meaningful to say — callers can
 * concat unconditionally and the prompt stays clean on the empty path.
 */
export function formatMemoryForPrompt(memory: PipelineMemory | null | undefined): string {
  if (!memory) return '';
  const m = coerceMemory(memory);
  const hasAny =
    m.recentConcepts.length > 0 ||
    m.successfulStyles.length > 0 ||
    m.avoidedNegatives.length > 0 ||
    Object.keys(m.nicheWeights).length > 0;
  if (!hasAny) return '';

  const lines: string[] = ['[SESSION MEMORY]'];
  if (m.recentConcepts.length > 0) {
    lines.push(`Recent concepts (don't repeat): ${m.recentConcepts.join(', ')}`);
  }
  if (m.successfulStyles.length > 0) {
    lines.push(`Styles that worked well: ${m.successfulStyles.join(', ')}`);
  }
  if (m.avoidedNegatives.length > 0) {
    lines.push(`Avoid these (led to rejected output): ${m.avoidedNegatives.join(', ')}`);
  }
  if (Object.keys(m.nicheWeights).length > 0) {
    const topNiches = Object.entries(m.nicheWeights)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([k, v]) => `${k}(${v})`)
      .join(', ');
    lines.push(`Active niches (weighted): ${topNiches}`);
  }

  return truncateWords(lines.join('\n'), MAX_FORMATTED_WORDS);
}

export const __test__ = {
  STORAGE_KEY,
  MAX_RECENT_CONCEPTS,
  MAX_SUCCESSFUL_STYLES,
  MAX_AVOIDED_NEGATIVES,
  MAX_NICHES,
  MAX_FORMATTED_WORDS,
};
