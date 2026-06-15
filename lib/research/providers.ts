/**
 * 4NE-16 — Provider tool slugs + PURE result mappers.
 *
 * Two responsibilities, both side-effect-free:
 *   1. Name the connector tool slugs we call (Exa / Tavily). These are the
 *      EXPECTED/default names; the EXACT slug is resolved from the connector's
 *      advertised tool list at runtime (a connector's toolkit may expose a
 *      variant spelling, e.g. `tavily_search` vs `tavily-search`), and
 *      `researchNiches` accepts overrides. We follow `lib/publish` /
 *      `lib/analytics`'s convention of never inventing tool names.
 *   2. Map a provider's raw MCP result into our normalised
 *      {@link NicheSuggestion}[]. The mappers are defensive over the providers'
 *      result shapes (a `results` array of `{ title, url, text/snippet/content,
 *      score, publishedDate }`), tolerate the MCP `content:[{type:'text',
 *      text:'<json>'}]` envelope, and turn garbage into `[]` (never throw).
 */

import type { NicheSuggestion } from './types';

// ---------------------------------------------------------------------------
// Tool slugs (runtime-overridable — see `researchNiches` deps)
// ---------------------------------------------------------------------------

/**
 * Exa web-search tool. The Exa MCP advertises `web_search_exa` as its primary
 * search tool. Resolve the exact slug from the connector's advertised tool list
 * at runtime if it differs; `researchNiches` accepts an override.
 */
export const EXA_SEARCH_TOOL = 'web_search_exa';

/**
 * Optional Exa content-fetch tool (`web_fetch_exa`) — fetches full page text
 * for a URL. Not required for niche suggestions (search results already carry
 * snippet text), but named here so a caller that wants richer summaries can
 * resolve + use it. Currently informational; the dispatcher does not call it.
 */
export const EXA_FETCH_TOOL = 'web_fetch_exa';

/**
 * Tavily search tool. The Tavily MCP commonly advertises `tavily_search` (some
 * toolkits spell it `tavily-search`). Resolve the exact slug from the
 * connector's advertised tool list at runtime if it differs; `researchNiches`
 * accepts an override.
 */
export const TAVILY_SEARCH_TOOL = 'tavily_search';

// ---------------------------------------------------------------------------
// Defensive plumbing (PURE)
// ---------------------------------------------------------------------------

/**
 * Normalise a raw MCP tool result into the underlying JS value we can read a
 * `results` array out of. Handles, in order:
 *   - the MCP content array `[{ type:'text', text:'<json>' }, ...]` — parse each
 *     text part and keep the first that yields an object/array;
 *   - a bare array (already the rows, or an array of text parts);
 *   - a plain object / string (parsed if it's a JSON string).
 * Anything unreadable collapses to `undefined`.
 */
function unwrap(raw: unknown): unknown {
  if (raw == null) return undefined;

  if (typeof raw === 'string') return safeJsonParse(raw) ?? raw;

  if (Array.isArray(raw)) {
    // An MCP content array of text parts: parse each and prefer the first that
    // decodes to something structured.
    let sawTextPart = false;
    for (const part of raw) {
      if (isTextPart(part)) {
        sawTextPart = true;
        const parsed = safeJsonParse(part.text);
        if (parsed != null && typeof parsed === 'object') return parsed;
      }
    }
    // No structured text part — treat the array itself as the rows (unless it
    // was purely text parts we couldn't parse, in which case nothing usable).
    return sawTextPart ? undefined : raw;
  }

  return raw;
}

function isTextPart(v: unknown): v is { type: 'text'; text: string } {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { type?: unknown }).type === 'text' &&
    typeof (v as { text?: unknown }).text === 'string'
  );
}

/** Pull the array of result rows out of a normalised value. */
function rowsFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['results', 'data', 'items', 'hits', 'documents', 'sources']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function safeJsonParse(s: string): unknown {
  const t = s.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** First non-empty trimmed string among the given keys, else undefined. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Coerce to a finite number, else undefined. */
function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v.trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/**
 * Map ONE raw result row into a {@link NicheSuggestion}, tagging `source`, or
 * `null` if the row is unusable (not an object, or has neither a title nor a
 * URL to anchor it). Shared by both providers — they share a row shape.
 */
function mapRow(row: unknown, source: NicheSuggestion['source']): NicheSuggestion | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const obj = row as Record<string, unknown>;

  const url = pickString(obj, ['url', 'link', 'href']);
  // Title falls back to the URL so a result with only a link is still usable.
  const title = pickString(obj, ['title', 'name', 'heading']) ?? url;
  if (!title) return null; // nothing to show → unusable

  const summary = pickString(obj, ['text', 'snippet', 'content', 'summary', 'description', 'excerpt']) ?? '';
  const score = pickNumber(obj, ['score', 'relevanceScore', 'relevance_score']);
  const publishedAt = pickString(obj, ['publishedDate', 'published_date', 'publishedAt', 'published_at', 'date']);

  const suggestion: NicheSuggestion = { title, summary, source };
  if (url) suggestion.url = url;
  if (score !== undefined) suggestion.score = score;
  if (publishedAt) suggestion.publishedAt = publishedAt;
  return suggestion;
}

function mapRows(raw: unknown, source: NicheSuggestion['source']): NicheSuggestion[] {
  const rows = rowsFrom(unwrap(raw));
  const out: NicheSuggestion[] = [];
  for (const row of rows) {
    const mapped = mapRow(row, source);
    if (mapped) out.push(mapped);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public mappers (PURE)
// ---------------------------------------------------------------------------

/**
 * Map an Exa search result into normalised {@link NicheSuggestion}[] tagged
 * `source:'exa'`. Defensive over Exa's `{ results: [{ title, url, text, score,
 * publishedDate }] }` shape and the MCP text-envelope; garbage → `[]`.
 */
export function mapExaResult(raw: unknown): NicheSuggestion[] {
  return mapRows(raw, 'exa');
}

/**
 * Map a Tavily search result into normalised {@link NicheSuggestion}[] tagged
 * `source:'tavily'`. Defensive over Tavily's `{ results: [{ title, url,
 * content, score, published_date }] }` shape and the MCP text-envelope;
 * garbage → `[]`.
 */
export function mapTavilyResult(raw: unknown): NicheSuggestion[] {
  return mapRows(raw, 'tavily');
}
