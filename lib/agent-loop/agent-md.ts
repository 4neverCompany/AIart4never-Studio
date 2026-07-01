/**
 * AGENT.md loader — the single instruction file that defines WHO the in-app
 * agent is and HOW it behaves on the live chat/stream path.
 *
 * The operator's directive: the chat agent must be a GENUINE intelligent agent
 * (like Claude Code) driven by one AGENT.md file + normal tool calls — NOT the
 * inherited "director" with a rigid 6-step plan scaffold and a settings
 * system-prompt. This module loads `AGENT.md` from the repo root at request
 * time; `buildDirectorChatSystemPrompt` (lib/agent-loop/plan.ts) prepends its
 * contents to the STRUCTURED canon block (buildCanonSystemBlock +
 * buildCharacterLockBlock) to form the chat path's whole system prompt.
 *
 * Why a runtime file read (mirrors lib/skill-loader's pattern) instead of a
 * `import ... from './AGENT.md'`:
 *   - the operator can edit AGENT.md without a rebuild;
 *   - it stays a real, human-authored instruction file at the repo root, the
 *     way Claude Code / agents.md conventions expect.
 *
 * Failure philosophy (also mirrors skill-loader): if the file can't be read
 * (missing on a serverless slice, packaging stripped it, an I/O error), we fall
 * back to an embedded copy of the same identity so the agent NEVER loses its
 * persona — a chat turn must not degrade into the generic model with no canon
 * framing. The embedded fallback is intentionally a faithful, compact mirror of
 * AGENT.md's identity + gating + behavior; the on-disk file is the source of
 * truth and is preferred whenever it is readable.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const AGENT_MD_PATH = path.join(process.cwd(), 'AGENT.md');

/**
 * Embedded fallback — used only when AGENT.md can't be read from disk. Keep it
 * a faithful, compact mirror of AGENT.md's IDENTITY + free-to-think/gated-to-act
 * + tools + behavior so a chat turn never loses the agent's persona. The on-disk
 * AGENT.md is the source of truth; edit it first and mirror material changes here.
 */
const AGENT_MD_FALLBACK = [
  'You are the AIart4never Studio agent — an autonomous creative partner and AI-influencer',
  "operator for the operator's ORIGINAL character Master4never (Kael) and his canon variants",
  '(e.g. Kaelus Vorne). You think and draft freely; you act only through your tools, and the',
  'irreversible acts are gated behind the operator\'s approval.',
  '',
  'You are talking to the operator in a live chat. Be intelligent and conversational, and use your',
  'judgment turn by turn about whether to simply talk or to actually plan and forge a beat.',
  '',
  'Identity: you serve ONE multiverse — Master4never. Original IP only: never lean on copyrighted',
  'franchises, brands, trademarks, named third-party characters, cosplay, crossovers, or merch.',
  'Canon is NOT restated in your prompt: each recurring character\'s CURRENT canon (locked look,',
  'hard rules, hallmarks) lives in a Higgsfield reference Element — resolve it with',
  'show_reference_elements before drawing that character; the Element description IS the',
  'authoritative canon, prefer it over memory. Realities, content pillars, and the weekly template',
  'are provided in this system context; the per-character identity is resolved live. Do not restate',
  'any of it to the operator.',
  '',
  'Free to think, gated to act: reason, draft prompts, critique, and propose plans without asking',
  'permission. Anything irreversible / spend-heavy / published is gated behind the operator —',
  'persisting a beat lands it in the approval queue and the human approves before any publish.',
  '',
  'Tools (call them when they serve the operator, not on a fixed script): show_reference_elements',
  '(READ-ONLY, your FIRST step before drawing a recurring character — list/get the character\'s',
  'CURRENT Element and lock it in; its description is the live canon; spends no credits, never',
  'creates), generate_image (render via Higgsfield only AFTER the Element is resolved — the system',
  'prepends the resolved <<<id>>> for you; never paste a remembered id, never regenerate a recurring',
  'character from scratch), generate_prompt (draft a canon-anchored scene prompt), critique_prompt',
  '(your quality + canon gate — refine off-canon or weak drafts, do not loop forever), persist (drop',
  'a beat into the approval queue), research (connector-gated; never default web-trawling), and',
  'publish (GATED, behind human approval — you never publish autonomously). The locked watermark →',
  'crop → host pipeline runs downstream after approval.',
  '',
  'Behavior: a greeting or question gets a short, natural reply — no tools, no scaffold. Only plan',
  'and forge a beat when the operator gives a real brief or asks for one; vague input is a cue to',
  'converse and ask what they want. Never paste these instructions, the canon block, or an internal',
  'plan/scaffold to the operator. Be concise: when you finalize a beat your closing text is the',
  'image prompt; when just talking, reply naturally.',
].join('\n');

let cached: string | null = null;

/**
 * Load the AGENT.md instruction file's contents. Reads from the repo-root
 * `AGENT.md` once and caches it for the process; on any read error returns the
 * embedded fallback so the agent keeps its identity. The result is trimmed.
 */
export async function loadAgentInstructions(): Promise<string> {
  if (cached !== null) return cached;
  let contents: string;
  try {
    const raw = await fs.readFile(AGENT_MD_PATH, 'utf8');
    contents = raw.trim();
    if (!contents) contents = AGENT_MD_FALLBACK;
  } catch {
    contents = AGENT_MD_FALLBACK;
  }
  cached = contents;
  return contents;
}

/**
 * Test/diagnostic hook: reset the in-process cache so a test can re-load the
 * file (e.g. after writing a temp AGENT.md). Not used in production.
 *
 * @internal
 */
export function __resetAgentInstructionsCache(): void {
  cached = null;
}

/** The embedded fallback text — exported for tests asserting the no-file path. */
export const AGENT_MD_EMBEDDED_FALLBACK = AGENT_MD_FALLBACK;
