/**
 * V080-DES-003 — single source of truth for the default agent system
 * prompt, parameterised by the user's selected niches and genres.
 *
 * Why this lives in lib/: SettingsModal's "Reset to Default" button
 * used to write a hardcoded paragraph that named "Marvel, DC, Star
 * Wars, Warhammer 40k" regardless of what the user had picked. Pulling
 * the prompt builder out of the component lets us interpolate the
 * actual selections (or fall back to the curated defaults if the user
 * has cleared everything) and keeps the same template usable from
 * anywhere else that needs to seed a fresh agent (onboarding, tests).
 *
 * The runtime call sites (useImageGeneration, usePipelineDaemon,
 * useIdeaProcessor) already append the LIVE niches/genres to whatever
 * `agentPrompt` contains at request time, so this template is the
 * "personality" baseline — the focus tags it lists set the agent's
 * default frame, and the live tag list overrides on every call.
 */

export const DEFAULT_NICHES: readonly string[] = [
  'Multiverse Crossovers',
  'Fan Fiction & Lore',
  'Merchandise & Collectibles',
  'Cosplay & Fan Art',
  'Pop Culture Crossovers',
  'Alternate Realities',
  'Sci-Fi & Fantasy',
  'Retro & Nostalgia',
  'Cyberpunk & Futurism',
  'Grimdark & Gothic',
  'Street-Level Heroes',
  'Galactic Empires',
  'Eldritch Horrors',
  'Mythic Legends',
];

export const DEFAULT_GENRES: readonly string[] = [
  'Visual Storytelling',
  'High Contrast',
  'Emotional Resonance',
  'Cinematic Crossovers',
  'What If Scenarios',
  'Alternative Timelines',
  'Epic Battles',
  'Character Dialogues',
  'Behind-the-Scenes Concepts',
  'Meme-worthy Mashups',
  'Deep Lore Explorations',
  'Hyper-Realistic',
  'Dramatic Lighting',
  'Epic Action',
  'Concept Art',
  'Digital Illustration',
  'Noir & Gritty',
  'Vibrant & Neon',
  'Surreal & Abstract',
  'Minimalist Design',
];

export interface BuildAgentPromptInput {
  niches?: readonly string[] | null;
  genres?: readonly string[] | null;
}

const FALLBACK_PILLAR_PHRASE = 'whichever space the user is exploring';
const FALLBACK_STYLE_PHRASE = 'across a flexible range of styles';

/**
 * AI-ROLE-REDESIGN (2026-05-22): drop the "prompt generator" framing
 * in favour of MashupForge AI as a studio-wide co-pilot. The user's
 * configured tags become the north star — the assistant treats them
 * as the orientation, not a list to ignore or override.
 *
 * Settings labels migrated in lockstep: "Platform Niches" →
 * "Content Pillars", "Target Genres" → "Style Tags". The underlying
 * settings keys (agentNiches, agentGenres) are unchanged so existing
 * user data survives — only display vocabulary shifts.
 *
 * Exported as a standalone const so inline fallbacks in
 * useIdeaProcessor / usePipelineDaemon / useImageGeneration / Sidebar
 * can reference the same baseline without going through the
 * parameterised builder.
 */
export const MASHUPFORGE_AI_PERSONA = [
  `You are MashupForge AI — the creative intelligence layer of a multi-model image generation studio.`,
  `You operate across the full feature set: idea generation, prompt optimization, parameter suggestion, trend analysis, and scheduling advice. You're a studio co-pilot, not a prompt-only tool.`,
  `The user has configured Content Pillars (what they create around) and Style Tags (aesthetic / mood / visual direction). Those tags are your north star — they tell you what THIS user cares about, more reliably than any hard-coded franchise list. Adapt every suggestion, prompt, and analysis to align with that configuration; never override the user's pillars with assumptions about what's popular.`,
  `When you generate image prompts: keep them SHORT and clean (40-60 words) — downstream prompt_enhance handles the expansion. When you optimize parameters or analyze trends: cross-reference against the configured tags to find opportunities that actually fit. When you suggest captions, schedules, or ideas: ground every choice in the Content Pillars + Style Tags above.`,
].join(' ');

/**
 * Build the default agent system prompt — the new MashupForge AI
 * persona plus a parameterised orientation built from the user's
 * Content Pillars + Style Tags. Both inputs are optional: empty/missing
 * arrays fall back to a neutral phrase so the prompt stays coherent
 * for users who haven't configured tags yet.
 *
 * Runtime call sites still append the LIVE pillars/tags on every
 * request (Content Pillars: …, Style Tags: …), so this baseline only
 * sets the default personality + initial orientation — the live tag
 * list always wins.
 */
export function buildDefaultAgentPrompt({ niches, genres }: BuildAgentPromptInput = {}): string {
  const pillarList = (niches && niches.length > 0) ? niches : null;
  const styleList = (genres && genres.length > 0) ? genres : null;

  const pillarPhrase = pillarList
    ? `the ${pillarList.join(' / ')} space`
    : FALLBACK_PILLAR_PHRASE;
  const stylePhrase = styleList
    ? `with a strong emphasis on ${styleList.slice(0, 6).join(', ')}${styleList.length > 6 ? `, and ${styleList.length - 6} more` : ''}`
    : FALLBACK_STYLE_PHRASE;

  return [
    MASHUPFORGE_AI_PERSONA,
    `Today's orientation: you're working in ${pillarPhrase}, ${stylePhrase}. Lean into "what if" scenarios, alternative timelines, and crossover composition when relevant — but only when the Content Pillars actually invite it.`,
    `Reach for visual storytelling, high contrast, and emotional resonance so the output reads well on social platforms (Instagram, TikTok, Twitter). Cross-reference trends with the user's configured tags before suggesting them — generic virality is not the goal, fit-to-pillar is.`,
  ].join(' ');
}
