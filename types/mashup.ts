import React from 'react';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface GeneratedImage {
  id: string;
  base64?: string;
  url?: string;
  /**
   * Filename (relative to `%APPDATA%\com.4nevercompany.mashupforge\images\generated\`)
   * of the local copy of this image on disk. Set by `useImageGeneration`
   * right after a successful generation; falls back to `url` when absent.
   *
   * Having the file on disk makes the image survive the Higgsfield CDN
   * URL expiring, makes the metadata store (mashupforge.json) tiny,
   * and means corruption of one image can't take down the whole
   * library — see lib/images/storage.ts.
   */
  localPath?: string;
  /**
   * V1.5: the CLEAN, pre-watermark source URL captured at generation
   * time. The "Re-apply watermark" action (Captioning / Post-Ready /
   * Gallery) composites onto this base instead of `url`, so repeated
   * re-applies never stack watermarks. Absent on legacy images (the
   * re-apply helper then falls back to `url`).
   */
  originalUrl?: string;
  prompt: string;
  imageId?: string;
  savedAt?: number;
  isVideo?: boolean;
  tags?: string[];
  collectionId?: string;
  /**
   * When set, this image belongs to a carousel post and shares its
   * caption / schedule with the other images in the same group. The
   * group itself is persisted in UserSettings.carouselGroups.
   */
  carouselGroupId?: string;
  postCaption?: string;
  postHashtags?: string[];
  approved?: boolean;
  isPostReady?: boolean;
  winner?: boolean;
  comparisonId?: string;
  status?: 'generating' | 'animating' | 'ready' | 'error';
  /**
   * Human-readable failure reason when status === 'error'. Set by the
   * client when Leonardo generation fails (API error, content filter,
   * timeout, or COMPLETE-with-0-images). Rendered as an overlay on
   * the placeholder card so the user sees what happened instead of a
   * stuck "generating" spinner.
   */
  error?: string;
  /**
   * Persistent record of the last manual "Post Now" attempt from the
   * Post Ready tab. Set by postImageNow / postCarouselNow on the
   * response. Used to render a persistent Posted / Failed badge that
   * survives tab switches and reloads (the in-flight `postStatus`
   * Record is component-local and lost on unmount).
   *
   * postedAt    epoch ms of the last successful post
   * postedTo    platforms the last successful post went to
   * postError   human-readable failure reason; cleared on success
   */
  postedAt?: number;
  postedTo?: string[];
  postError?: string;
  modelInfo?: {
    // V1.1.1-MULTI-PROVIDER-VIDEO: widened to include `'mmx'` for
    // the multi-provider video path (the `mmx` provider in
    // settings.videoProviders is the CLI-based fallback). The
    // Studio's Animate button writes the matching provider id so
    // the gallery badge + post-lifecycle code can route correctly.
    // Existing entries (leonardo/minimax/higgsfield) keep their
    // meanings; mmx is the new optional fourth value.
    provider: 'leonardo' | 'minimax' | 'higgsfield' | 'mmx';
    modelId: string;
    modelName: string;
  };
  universe?: string;
  style?: string;
  seed?: number;
  negativePrompt?: string;
  aspectRatio?: string;
  imageSize?: string;
  /**
   * V040-HOTFIX-007: marks a pipeline-generated image whose associated
   * ScheduledPost is still `pending_approval`. Gallery views filter these
   * out so Gallery remains the "finalized, watermarked images" pool.
   * Cleared (and the image watermarked) when the post is approved via
   * `MashupContext.approveScheduledPost` / `bulkApproveScheduledPosts`,
   * or skipped entirely when the pipeline auto-approves (all platforms
   * auto, post lands as `scheduled` directly).
   */
  pipelinePending?: boolean;
  /**
   * For pipeline-produced images, the id of the source Idea that
   * drove the generation. Mirrors ScheduledPost.sourceIdeaId and lets
   * the daemon's skip-handler find every image it created for the
   * current idea (including ones saved before scheduling) so they can
   * be deleted instead of lingering as orphaned pipelinePending entries.
   */
  sourceIdeaId?: string;
}

/**
 * A grouped set of images published as a single carousel post. The user
 * can edit a shared caption / schedule / platform list, and the auto-post
 * worker fans each platform out with the full `imageIds` array as
 * `mediaUrls`.
 */
export interface CarouselGroup {
  id: string;
  imageIds: string[];
  caption?: string;
  hashtags?: string[];
  scheduledDate?: string;
  scheduledTime?: string;
  platforms?: string[];
  status?: 'draft' | 'scheduled' | 'posted' | 'failed';
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
}

export interface GenerateOptions {
  negativePrompt?: string;
  aspectRatio?: string;
  imageSize?: string;
  provider?: 'leonardo';
  /**
   * Image-pipeline provider override. Defaults to the active model's
   * `provider` field in LEONARDO_MODELS (`'leonardo'` for all classic
   * models, `'minimax'` for MiniMax-native models like image-01). Set
   * explicitly when the caller needs to force a route; otherwise the
   * model entry decides.
   *
   * HIGGSFIELD-INTEGRATION: `'higgsfield'` is the third image
   * provider. The /api/higgsfield/{image,video} routes forward to
   * the MCP `higgsfield_generate` tool with the model's `apiName`
   * (Higgsfield job_set_type slug) as the `model` arg.
   */
  imageProvider?: 'leonardo' | 'minimax' | 'higgsfield';
  leonardoModel?: string;
  skipEnhance?: boolean;
  style?: string;
  lighting?: string;
  angle?: string;
  seed?: number;
  cfgScale?: number;
  /** GPT-Image-1.5 only: LOW | MEDIUM | HIGH. Ignored by other models. */
  quality?: 'LOW' | 'MEDIUM' | 'HIGH';
  /**
   * V030-008: Leonardo's prompt_enhance knob. Defaults to 'ON' (set on
   * the server in /api/leonardo/route.ts). Surfaced here so the Studio
   * smart-suggest card and any future UI can explicitly override.
   */
  promptEnhance?: 'ON' | 'OFF';
  /**
   * V090-PIPELINE-STYLE-DIVERSITY: per-model parameter overrides. Keyed
   * by in-app model id. The pipeline's suggestParametersAI call produces
   * a different style per nano-banana variant; this field carries those
   * per-model picks into generateComparison so siblings don't all get
   * the same style. Falls back to the shared style when a model has no
   * entry here.
   */
  perModelOptions?: Record<string, { style?: string; aspectRatio?: string; negativePrompt?: string }>;
  /**
   * Per-model failure callback. Fired from the generateComparison loop
   * whenever a single model's submitOnce throws (Leonardo 400, MiniMax
   * 4xx, network error, moderation block that survived the rewrite).
   * Pipeline callers wire this to addLog so users see WHY a model
   * didn't appear in readyImages — without it, per-model errors land
   * only on the Compare panel's placeholder state and the Pipeline
   * just looks like fewer-than-expected images came back.
   */
  onModelError?: (modelId: string, modelName: string, error: string) => void;
  // V1.7.0-PROVIDER-LOG: fired once per image that reaches `ready`, with the
  // actual backend provider ('leonardo' | 'higgsfield' | 'minimax' | …) that
  // produced it. The pipeline wires this to the activity log so the user can
  // see WHICH provider generated each image (the gallery badge already shows
  // it post-hoc; this surfaces it live in the run timeline).
  onModelSuccess?: (modelId: string, modelName: string, provider: string) => void;
}

export interface WatermarkSettings {
  enabled: boolean;
  image: string | null;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  opacity: number;
  scale: number;
  /**
   * V1.7.1-M3.2b-WATERMARK-DISK: persistent reference to the on-disk
   * watermark file. Optional for backward compat with stores that
   * pre-date M3.2b — see lib/watermarks/migrate.ts for the upgrade
   * path. When `image` is a data-URL and `imageRef` is missing, the
   * migration runs once on next hydration and writes `imageRef` back.
   */
  imageRef?: WatermarkImageRef;
}

/**
 * V1.7.1-M3.2b-WATERMARK-DISK: a thin reference to the on-disk
 * watermark file. The `image` field on `WatermarkSettings` is still
 * the runtime-loadable URL (asset:// in Tauri, data: in the migration
 * path / web preview); `imageRef` is what gets persisted and survives
 * across restarts. The migration in lib/watermarks/migrate.ts
 * populates `imageRef` from a legacy in-store data-URL the first time
 * the store hydrates.
 */
export interface WatermarkImageRef {
  /** Content-addressed 8-char hex hash (FNV-1a 32-bit, see storage.ts). */
  hash: string;
  /** On-disk filename relative to the watermark dir, e.g. "wm_1f2e3a4b.png". */
  filename: string;
  /** MIME type as uploaded — drives the extension AND the runtime src. */
  mimeType: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'image/webp' | 'image/gif';
  /** Byte size — used for the settings UI "Logo: 320 KB" line. */
  size: number;
}

export interface AgentPersonality {
  id: string;
  name: string;
  prompt: string;
  niches: string[];
  genres: string[];
}

export interface Idea {
  id: string;
  concept: string;
  context?: string;
  createdAt: number;
  status: 'idea' | 'in-work' | 'done';
}

export type PostPlatform = 'instagram' | 'pinterest' | 'twitter' | 'discord';

export interface ScheduledPost {
  id: string;
  imageId: string;
  date: string;
  time: string;
  platforms: string[];
  caption: string;
  /**
   * Pipeline-produced posts enter as 'pending_approval' and need an
   * explicit approval step (via approveScheduledPost) before the auto-
   * poster will pick them up. User-scheduled posts go straight to
   * 'scheduled' and skip the approval queue.
   */
  status?: 'pending_approval' | 'scheduled' | 'posted' | 'failed' | 'rejected';
  /**
   * Optional link between scheduled posts that belong to the same
   * carousel. When set, the auto-post worker collects every post with
   * this id and publishes them as a single multi-image post (mediaUrls
   * fan-out) instead of N separate single-image calls.
   */
  carouselGroupId?: string;
  /**
   * For pipeline-produced posts, the id of the source Idea that
   * generated this post. Lets the bulk-approval queue group/filter by
   * topic and lets the feedback loop attribute approvals back to the
   * idea concept.
   */
  sourceIdeaId?: string;
  /**
   * V1.3: predicted virality score (0–100) computed by the
   * Higgsfield brain_activity model when the post enters
   * pending_approval. Null if the score hasn't been computed yet
   * (e.g. posts created before v1.3 upgrade, or provider unavailable).
   */
  viralityScore?: number | null;
}

export interface UserSettings {
  enabledProviders: 'leonardo'[];
  apiKeys: {
    leonardo?: string;
    instagram?: {
      accessToken: string;
      igAccountId: string;
    };
    twitter?: {
      appKey: string;
      appSecret: string;
      accessToken: string;
      accessSecret: string;
    };
    pinterest?: {
      accessToken: string;
      boardId?: string;
    };
    discordWebhook?: string;
  };
  defaultLeonardoModel: string;
  defaultVideoModel?: string;
  /**
   * V1.1.1-MULTI-PROVIDER-VIDEO: ordered list of providers the user
   * wants to fire in parallel when they click "Animate" in the
   * Studio. Replaces the implicit "always Leonardo" behavior of
   * v1.1.0. Empty array means "no providers selected" — the Animate
   * button surfaces an error in that case.
   *
   * Order is preserved for the toast / gallery sort: the first
   * successful result lands first in the gallery grid.
   *
   * Default is `['minimax']` (Hailuo 2.3) — Maurice's v1.1.1
   * direction. Users with persisted v1.1.0 settings (no
   * `videoProviders` field) get this new default on first load
   * after upgrade; the Settings modal lets them re-add Leonardo or
   * Higgsfield if they want.
   *
   * `mmx` is the CLI-wrapper variant of `minimax` — included here
   * so the Settings modal can offer both paths. In practice the
   * user usually picks one or the other (not both); the Animate
   * button honors whatever's checked.
   */
  videoProviders?: ('leonardo' | 'minimax' | 'higgsfield' | 'mmx')[];
  /**
   * V1.1.1-MULTI-PROVIDER-VIDEO: per-provider MiniMax video model
   * slug (e.g. 'MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02'). Lives
   * alongside `defaultHiggsfieldVideoModel` and the legacy
   * `defaultVideoModel` (Leonardo). Each provider has its own
   * model picker so switching providers doesn't clobber the
   * others.
   */
  defaultMinimaxVideoModel?: string;
  /**
   * V1.1.1-SKILLS-AUTO-USE: list of [agents.md](https://agents.md)
   * skill names from `docs/research/higgsfield-skills/` that the
   * user wants auto-injected into the system prompt on every AI
   * generation. Each skill's body markdown is appended to the
   * system prompt as an authoritative directive.
   *
   * Default: `['banana-pro-director']` (the SLCT + Skin Study
   * director protocol) — it's small, focused, and immediately
   * improves prompt quality for the user's crossover / cinematic
   * use case. Users can disable it (or add others) in the
   * Settings → AI Engine panel.
   */
  activeSkills?: string[];
  /**
   * HIGGSFIELD-INTEGRATION: per-user default models for the
   * Higgsfield MCP-backed image + video generation. Populated by
   * the Settings → AI Engine → Higgsfield panel; consumed by
   * useImageGeneration when the user picks a higgsfield-* spec
   * (and by the pipeline when `imageSource === 'higgsfield'`).
   * Slugs are `job_set_type` strings (e.g. 'nano_banana_2',
   * 'seedance_2_0') from lib/higgsfield/models.ts.
   */
  defaultHiggsfieldImageModel?: string;
  defaultHiggsfieldVideoModel?: string;
  /**
   * V1.4.0: opt-in toggle. When false (the default), the pipeline
   * uses Leonardo only — the existing workflow is preserved. When
   * true, the hook round-robins through `higgsfieldImageModels` and
   * generates one Higgsfield image per idea in parallel with the
   * Leonardo one. The user gets both, picks the best.
   */
  higgsfieldEnabled?: boolean;
  /**
   * V1.4.0: which Higgsfield image models the user wants to exercise
   * (slug list, e.g. `['nano_banana_2', 'flux_2', 'gpt_image_2']`).
   * The pipeline round-robins through this list. Defaults to
   * `['nano_banana_2']` when `higgsfieldEnabled` is true but no
   * list is set.
   */
  higgsfieldImageModels?: string[];
  /**
   * V1.4.0: unified model id (e.g. `higgsfield:nano_banana_2`,
   * `nano-banana-2`). When set, takes precedence over both
   * `defaultHiggsfieldImageModel` and `defaultLeonardoModel`.
   * Populated by `pickDefaultImageModel` in lib/image-models.ts.
   */
  defaultImageModel?: string;
  /** V1.2.5: power-user CLI-token entry. Set this if you have a
   *  Higgsfield API key from `npx @higgsfield/cli auth` and don't
   *  want to go through the OAuth web flow. The Director loop
   *  prefers CLI tokens over OAuth when both are present. */
  higgsfieldCliToken?: string;
  /** Cached connection state for the Settings panel. */
  higgsfieldConnected?: boolean;
  defaultAnimationDuration?: 3 | 5 | 10;
  defaultAnimationStyle?: string;
  /** V1.0.7-PROMPT-ENG-A4: when true, the curated anti-AI-look
   * negative prompt list is appended to every image generation
   * request (Leonardo's `negative_prompt` field, Higgsfield MCP's
   * `negative_prompt`). The user-facing control lives in
   * Settings → AI Engine (see SettingsModal). Default false so
   * existing users' output doesn't change. */
  antiAiLook?: boolean;
  /** V1.6: agentic "Director" pipeline. When true, the pipeline's
   * idea→prompt step routes through the multi-step tool-use loop
   * (trending_search → generate_prompt → critique → refine) via
   * `/api/ai/prompt` mode:director instead of sending the idea concept
   * to the image model verbatim. Shipped opt-in in v1.5.0; the DEFAULT
   * path since v1.6.0 (`applyV160DirectorDefaultMigration` flips
   * stored `false` values from the old default unless the user
   * explicitly chose — see `directorPipelineUserSet`). Any Director
   * failure falls back to the verbatim concept so the pipeline never
   * stalls. Requires at least one agentNiche (the Director route
   * validates 1-6 niches) and a configured text-AI provider
   * (MINIMAX_API_KEY / OPENAI_API_KEY). The control lives in
   * Settings → AI Engine. */
  useDirectorPipeline?: boolean;
  /** V1.6: stamped `true` whenever the user clicks the Director
   * toggle in Settings. An explicit choice — on OR off — is never
   * overridden by a future default migration. Absent for users who
   * never touched the switch (they follow the current default). */
  directorPipelineUserSet?: boolean;
  /** V1.0.7-PROMPT-ENG-A2/A3: optional camera-angle slug from the
   * 14-angle catalog in `lib/camera-angles.ts`. When set, the
   * `buildEnhancedPrompt` composer appends a structured MCSLA
   * `C:` fragment (angle + lens + intent) to the positive prompt.
   * Stored as a string slug, not the label, so renames don't
   * break user data. */
  cameraAngle?: string;
  /** V1.0.7-PROMPT-ENG-D: optional monthly credit cap for the
   * Higgsfield provider. When set, the gate in
   * `lib/credit-budget.ts` blocks Higgsfield submissions once the
   * cycle usage hits this number. Undefined = gate disabled.
   * The cycle is reset manually via Settings → Credit Budget. */
  higgsfieldMonthlyCreditCap?: number;
  watermark?: WatermarkSettings;
  agentPrompt?: string;
  agentNiches?: string[];
  agentGenres?: string[];
  channelName?: string;
  savedPersonalities?: AgentPersonality[];
  scheduledPosts?: ScheduledPost[];
  /** Persistent carousel groups (multi-image posts). */
  carouselGroups?: CarouselGroup[];
  /** Pipeline stage toggles. Default (undefined) is treated as true for
   *  auto-tag/caption/schedule. The auto-post toggle was removed in
   *  V060-004 — every pipeline post lands as pending_approval and
   *  publishes through the approval flow. */
  pipelineAutoTag?: boolean;
  pipelineAutoCaption?: boolean;
  pipelineAutoSchedule?: boolean;
  /** Platforms the pipeline should schedule posts for. */
  pipelinePlatforms?: string[];
  /**
   * V040-008: per-platform approval gating. When a pipeline-produced
   * post's platforms include any platform whose toggle is `false`,
   * the post enters as `pending_approval` and waits for explicit user
   * approval. When ALL of a post's platforms are `true`, it lands
   * directly as `scheduled`. Missing entry resolves via defaults —
   * Instagram defaults to manual approval (false); all others default
   * to auto (true). The Instagram default is intentional: its Graph
   * API is the one that most often surfaces flagged content or
   * rate-limit issues, and silent auto-post surprises aren't worth
   * the convenience.
   */
  pipelineAutoApprove?: Partial<
    Record<'instagram' | 'pinterest' | 'twitter' | 'discord', boolean>
  >;
  /**
   * Per-platform daily post caps for the smart scheduler. When set,
   * the scheduler refuses to place a new post on a day where the
   * count of same-platform `scheduled` / `pending_approval` posts
   * already meets the cap. `posted` and `failed` posts are not
   * counted (they're done — the user explicitly opted in to "only
   * scheduled posts count" so the cap doesn't leak through history).
   * Missing entry = no cap for that platform.
   */
  pipelineDailyCaps?: Partial<Record<'instagram' | 'pinterest' | 'twitter' | 'discord', number>>;
  /**
   * V030-004: target posts-per-day the week-fill strategy aims for.
   * Drives the "schedule target met" decision in continuous mode and
   * the Week Progress meter. Unset → default of 2/day for back-compat
   * with the pre-V030-004 hard-coded rate.
   */
  pipelinePostsPerDay?: number;
  /**
   * When on, pipeline runs collapse all ready images from a single idea
   * into ONE carousel post: one shared caption, one scheduled slot, and
   * N ScheduledPosts that share a carouselGroupId (the auto-poster then
   * fans them out as a multi-image post). Also drives the Ideas Board
   * manual flow — ready comparison results auto-group into a carousel.
   */
  pipelineCarouselMode?: boolean;
  /**
   * When on, the continuous-mode daemon's auto-idea generator asks pi
   * for ONE shared theme plus N variations on it, instead of N random
   * unrelated ideas. Produces a more cohesive feed (e.g. "Retro Saturday
   * Morning Cartoons × Horror" → Scooby-Doo/Texas Chainsaw, Looney
   * Tunes/Scream, Muppets/Suspiria). Off = legacy random-ideas mode.
   */
  pipelineThemedBatches?: boolean;
  /**
   * V040-001: when on, the week view overlays an engagement heatmap
   * (gold tint per slot, top-3 star markers, hover tooltip with score
   * breakdown). Off by default — opt-in via the header toggle.
   */
  heatmapEnabled?: boolean;
  /**
   * M3.3-P3 commit a: narrowed from `'pi' | 'nca' | 'mmx' | 'vercel-ai'`
   * to just `'vercel-ai'`. The pi/nca/mmx subprocess agents are being
   * retired in v1.8.0 (see `I:\MashupForge-handoff\plans\m33-p3-recon-2026-06-12.md`).
   * The runtime default in `lib/aiClient.ts` now reads `?? 'vercel-ai'`
   * and a one-shot IDB migration in `useSettings.ts` rewrites any
   * persisted `'pi' | 'nca' | 'mmx'` value to `'vercel-ai'` on first
   * load after upgrade.
   *
   * @deprecated Use {@link aiAgentProvider} instead — kept on the type
   * for one release so persisted user-settings payloads still validate;
   * read sites should fall back to it for back-compat.
   */
  activeAiAgent?: 'vercel-ai';
  /**
   * M3.3-P3 commit a: narrowed to `'vercel-ai'` only. See
   * {@link activeAiAgent} for the full migration story.
   */
  aiAgentProvider?: 'vercel-ai';
  /**
   * P3 of PROV-AGNOSTIC-PARAMS: user-selected text model for vercel-ai
   * runs. When set, all vercel-ai prompt calls forward this through
   * `streamAI({ model })` → `/api/ai/prompt body.model`, which the
   * route's `resolveProvider` accepts as an override before falling
   * back to the env-derived default. Only honoured under vercel-ai;
   * pi/nca/mmx select their own model server-side via subprocess flags.
   * Undefined → vercel-ai route picks the env-derived default
   * (`VERCEL_AI_MODEL` env or per-provider built-in default).
   */
  activeTextModel?: string;
}

export type ViewType = 'studio' | 'gallery' | 'compare' | 'captioning' | 'post-ready' | 'ideas' | 'pipeline';

export interface PipelineLogEntry {
  timestamp: Date;
  step: string;
  ideaId: string;
  status: 'success' | 'error';
  message: string;
}

export interface PipelineProgress {
  current: number;
  total: number;
  currentStep: string;
  currentIdea: string;
  /**
   * Id of the in-flight idea. Lets the UI look up the full Idea record
   * (and any state attached to it) instead of doing a fragile concept-
   * text match. Optional for backwards compatibility with the existing
   * "Auto-generating ideas" intermediate progress state, which has no
   * single owning idea.
   */
  currentIdeaId?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const RECOMMENDED_NICHES = [
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
  'Mythic Legends'
];

export const RECOMMENDED_GENRES = [
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
  'Minimalist Design'
];

// ── Leonardo Models (API-documented) ──────────────────────────────────────

export interface LeonardoModelConfig {
  id: string;
  name: string;
  apiModelId: string;
  version: 'v2' | 'v1';
  supportsStyleIds: boolean;
  supportsQuality: boolean;      // GPT Image-1.5 / GPT Image-2 only
  supportsGuidance: boolean;
  maxQuantity: number;
  aspectRatios: { label: string; width: number; height: number }[];
  styles?: { name: string; uuid: string }[];
  /**
   * Backend provider. Undefined defaults to `'leonardo'` for backwards
   * compatibility with every model added before MiniMax-native support
   * landed. `'minimax'` routes the request to `/api/minimax-image` and
   * uses MiniMax's `image_generation` endpoint instead of Leonardo's v2
   * `generations` API; the `apiModelId` is then the MiniMax model name
   * (e.g. `'image-01'`), not a Leonardo model id.
   */
  provider?: 'leonardo' | 'minimax';
}

// Shared styles for Nano Banana 2 and Nano Banana Pro (API-documented, 19 styles)
export const LEONARDO_SHARED_STYLES = [
  { name: 'None', uuid: '556c1ee5-ec38-42e8-955a-1e82dad0ffa1' },
  { name: 'Dynamic', uuid: '111dc692-d470-4eec-b791-3475abac4c46' },
  { name: 'Creative', uuid: '6fedbf1f-4a17-45ec-84fb-92fe524a29ef' },
  { name: 'Ray Traced', uuid: 'b504f83c-3326-4947-82e1-7fe9e839ec0f' },
  { name: 'Pro Color Photography', uuid: '7c3f932b-a572-47cb-9b9b-f20211e63b5b' },
  { name: 'Portrait', uuid: '8e2bc543-6ee2-45f9-bcd9-594b6ce84dcd' },
  { name: 'Portrait Cinematic', uuid: '4edb03c9-8a26-4041-9d01-f85b5d4abd71' },
  { name: 'Portrait Fashion', uuid: '0d34f8e1-46d4-428f-8ddd-4b11811fa7c9' },
  { name: 'Fashion', uuid: '594c4a08-a522-4e0e-b7ff-e4dac4b6b622' },
  { name: 'Stock Photo', uuid: '5bdc3f2a-1be6-4d1c-8e77-992a30824a2c' },
  { name: 'Illustration', uuid: '645e4195-f63d-4715-a3f2-3fb1e6eb8c70' },
  { name: '3D Render', uuid: 'debdf72a-91a4-467b-bf61-cc02bdeb69c6' },
  { name: 'Game Concept', uuid: '09d2b5b5-d7c5-4c02-905d-9f84051640f4' },
  { name: 'Acrylic', uuid: '3cbb655a-7ca4-463f-b697-8a03ad67327c' },
  { name: 'Watercolor', uuid: '1db308ce-c7ad-4d10-96fd-592fa6b75cc4' },
  { name: 'Graphic Design 2D', uuid: '703d6fe5-7f1c-4a9e-8da0-5331f214d5cf' },
  { name: 'Graphic Design 3D', uuid: '7d7c2bc5-4b12-4ac3-81a9-630057e9e89f' },
  { name: 'Pro B&W Photography', uuid: '22a9a7d2-2166-4d86-80ff-22e2643adbcf' },
  { name: 'Pro Film Photography', uuid: '581ba6d6-5aac-4492-bebe-54c424a0d46e' },
];

export const LEONARDO_MODELS: LeonardoModelConfig[] = [
  {
    id: 'nano-banana',
    name: 'Nano Banana',
    apiModelId: 'nano-banana',
    version: 'v2',
    supportsStyleIds: true,
    supportsQuality: false,
    supportsGuidance: true,
    maxQuantity: 8,
    aspectRatios: [
      { label: '1:1', width: 1024, height: 1024 },
      { label: '4:5', width: 896, height: 1152 },
      { label: '5:4', width: 1152, height: 896 },
      { label: '3:4', width: 768, height: 1024 },
      { label: '4:3', width: 1024, height: 768 },
      { label: '9:16', width: 768, height: 1344 },
      { label: '16:9', width: 1344, height: 768 },
    ],
    styles: LEONARDO_SHARED_STYLES,
  },
  {
    id: 'nano-banana-2',
    name: 'Nano Banana 2',
    apiModelId: 'nano-banana-2',
    version: 'v2',
    supportsStyleIds: true,
    supportsQuality: false,
    supportsGuidance: true,
    maxQuantity: 8,
    aspectRatios: [
      { label: '1:1', width: 1024, height: 1024 },
      { label: '2:3', width: 1024, height: 1536 },
      { label: '3:2', width: 1536, height: 1024 },
      { label: '3:4', width: 768, height: 1024 },
      { label: '9:16', width: 768, height: 1344 },
    ],
    styles: LEONARDO_SHARED_STYLES,
  },
  {
    id: 'nano-banana-pro',
    name: 'Nano Banana Pro',
    apiModelId: 'gemini-image-2',
    version: 'v2',
    supportsStyleIds: true,
    supportsQuality: false,
    supportsGuidance: true,
    maxQuantity: 8,
    aspectRatios: [
      { label: '1:1', width: 1024, height: 1024 },
      { label: '2:3', width: 1024, height: 1536 },
      { label: '3:2', width: 1536, height: 1024 },
    ],
    styles: LEONARDO_SHARED_STYLES,
  },
  {
    id: 'gpt-image-1.5',
    name: 'GPT Image-1.5',
    apiModelId: 'gpt-image-1.5',
    version: 'v2',
    supportsStyleIds: false,
    supportsQuality: true,
    supportsGuidance: true,
    maxQuantity: 4,
    aspectRatios: [
      { label: '1:1', width: 1024, height: 1024 },
      { label: '2:3', width: 1024, height: 1536 },
      { label: '3:2', width: 1536, height: 1024 },
    ],
  },
  {
    id: 'gpt-image-2',
    name: 'GPT Image-2',
    apiModelId: 'gpt-image-2',
    version: 'v2',
    // Same capability profile as gpt-image-1.5: no style_ids, accepts the
    // quality parameter (LOW/MEDIUM/HIGH), guidance-friendly. Quantity
    // cap raised to 8 per Leonardo docs for the newer model.
    supportsStyleIds: false,
    supportsQuality: true,
    supportsGuidance: true,
    maxQuantity: 8,
    // 5 ratios: 3 baseline shared with gpt-image-1.5 + 16:9/9:16. If
    // Leonardo rejects the wide/tall pair with a v2 VALIDATION_ERROR,
    // swap them to 4:5 (896x1152) and 5:4 (1152x896) — every 1.5/Nano
    // model already accepts that pair so it's a known-safe fallback.
    aspectRatios: [
      { label: '1:1', width: 1024, height: 1024 },
      { label: '2:3', width: 1024, height: 1536 },
      { label: '3:2', width: 1536, height: 1024 },
      { label: '16:9', width: 1344, height: 768 },
      { label: '9:16', width: 768, height: 1344 },
    ],
  },
  {
    id: 'minimax-image-01',
    name: 'MiniMax Image-01',
    // MiniMax's own `image_generation` endpoint, not a Leonardo model.
    // The route /api/minimax-image branches on this and forwards to
    // {MINIMAX_API_BASE_URL}/image_generation with model="image-01".
    apiModelId: 'image-01',
    provider: 'minimax',
    version: 'v1',
    // image-01 has no style UUIDs, no quality enum, and no guidance
    // knob — it's a single-config endpoint with prompt_optimizer being
    // its only quality lever.
    supportsStyleIds: false,
    supportsQuality: false,
    supportsGuidance: false,
    // image-01 accepts n: 1-9 in one request, beating every Leonardo
    // model's per-call cap.
    maxQuantity: 9,
    aspectRatios: [
      { label: '1:1', width: 1024, height: 1024 },
      { label: '16:9', width: 1280, height: 720 },
      { label: '4:3', width: 1152, height: 864 },
      { label: '3:2', width: 1248, height: 832 },
      { label: '2:3', width: 832, height: 1248 },
      { label: '3:4', width: 864, height: 1152 },
      { label: '9:16', width: 720, height: 1280 },
      { label: '21:9', width: 1344, height: 576 },
    ],
  },
];

/**
 * Per-model prompt engineering guides. Before sending a prompt to
 * Leonardo we ask pi to rewrite it using the guide for the target
 * model, which substantially narrows quality variance between models.
 *
 * Keys must match LEONARDO_MODELS[].id, not apiModelId — we want to
 * optimise for the user-facing model choice.
 */
export const MODEL_PROMPT_GUIDES: Record<string, string> = {
  'nano-banana': `This model works best with concise, visually descriptive prompts focused on:
- Clear subject description with specific visual attributes (colors, textures, materials)
- Explicit lighting and atmosphere keywords (dramatic lighting, golden hour, neon glow)
- Art style keywords (digital art, concept art, cinematic, illustration style)
- Avoid overly long prompts — keep it focused and vivid
- Negative prompts are effective for this model`,

  'nano-banana-2': `This model works best with concise, visually descriptive prompts focused on:
- Clear subject description with specific visual attributes (colors, textures, materials)
- Explicit lighting and atmosphere keywords (dramatic lighting, golden hour, neon glow)
- Art style keywords (digital art, concept art, cinematic, illustration style)
- Avoid overly long prompts — keep it focused and vivid
- Negative prompts are effective for this model`,

  'nano-banana-pro': `This model excels with:
- Detailed scene composition (foreground/midground/background)
- Photorealistic rendering keywords (photorealistic, 8k, ultra detailed, sharp focus)
- Complex multi-subject scenes with spatial relationships
- Specific camera and lens descriptors (85mm, shallow depth of field, wide angle)
- Atmospheric effects (volumetric lighting, lens flare, depth of field)`,

  'gpt-image-1.5': `This model is best at:
- Photorealistic image generation with accurate text rendering
- Precise spatial composition and perspective
- Complex scenes with multiple interacting elements
- Use natural language descriptions — this model understands context well
- Specify text/labels/logos explicitly and they will render correctly
- Avoid negative prompts — not well supported`,

  'gpt-image-2': `GPT Image-2 is OpenAI's GPT-architecture image model
(same family as DALL-E 3). Prompts can be longer and more detailed than
Nano Banana models.
- Include character descriptions, setting, lighting/style tags,
  composition notes
- Text rendering is significantly better than other models — spell out
  text/labels/logos literally
- Do not use leetspeak or obfuscation
- Keep trademark names as-is — they pass fine
- Best results with 60-100 word detailed prompts containing clear scene
  description, subject detail, and quality tags (cinematic, 8k, etc.)
- Avoid stacking violence vocabulary — keep grimdark tone from lighting
  and atmosphere, not gore descriptions`,
};

// V030-007-followup: Authoritative per-model API parameter spec from
// Maurice's model-params.json. This is the source of truth for what
// the Leonardo v2 API actually accepts per model — width/height,
// supported sizes, quality levels, durations, and frame capabilities.
// Smart pre-fill in lib/param-suggest.ts consults this map to avoid
// suggesting values the API will reject.
export interface LeonardoImageModelSpec {
  type: 'image';
  width: number;
  height: number;
  supported_sizes: readonly string[];
  quality?: readonly ('LOW' | 'MEDIUM' | 'HIGH')[];
  style_ids?: boolean;
  prompt_enhance: 'OFF' | 'ON';
  supports_image_reference: boolean;
  /** API name if different from the public id (e.g. gemini-image-2). */
  api_name?: string;
}

export interface LeonardoVideoModelSpec {
  type: 'video';
  width: number;
  height: number;
  duration: number;
  mode: string;
  motion_has_audio?: boolean;
  supports_start_frame: boolean;
  supports_end_frame: boolean;
  /** API name if different from the public id (e.g. VEO3_1). */
  api_name?: string;
}

export type LeonardoModelSpec = LeonardoImageModelSpec | LeonardoVideoModelSpec;

export const LEONARDO_MODEL_PARAMS: Record<string, LeonardoModelSpec> = {
  // V030-008: prompt_enhance defaults to 'ON' for all image models —
  // Maurice wants Leonardo to auto-improve prompts unless the user
  // explicitly opts out. Matches the `/api/leonardo/route.ts` default.
  'gpt-image-1.5': {
    type: 'image',
    width: 1024,
    height: 1024,
    supported_sizes: ['1024x1024'],
    quality: ['LOW', 'MEDIUM', 'HIGH'],
    // V085-GPT15-STYLE-FIX: explicitly false (not just absent). gpt-image-1.5
    // has NO style parameter — the param-suggest rule engine reads this flag
    // to decide whether to assign a style. Leaving it undefined would still
    // be falsy but invites accidental regressions; spelling it out is the
    // canonical capability declaration.
    style_ids: false,
    prompt_enhance: 'ON',
    supports_image_reference: true,
  },
  'gpt-image-2': {
    type: 'image',
    width: 1024,
    height: 1024,
    supported_sizes: ['1024x1024'],
    quality: ['LOW', 'MEDIUM', 'HIGH'],
    // Same style_ids posture as gpt-image-1.5 — GPT family has no style
    // parameter. param-suggest reads this flag to skip style assignment.
    style_ids: false,
    prompt_enhance: 'ON',
    supports_image_reference: true,
  },
  'nano-banana-2': {
    type: 'image',
    width: 1024,
    height: 1024,
    supported_sizes: ['1024x1024'],
    style_ids: true,
    prompt_enhance: 'ON',
    supports_image_reference: false,
  },
  'nano-banana-pro': {
    type: 'image',
    api_name: 'gemini-image-2',
    width: 1024,
    height: 1024,
    supported_sizes: ['1024x1024'],
    style_ids: true,
    prompt_enhance: 'ON',
    supports_image_reference: false,
  },
  'minimax-image-01': {
    // P2 of PROV-AGNOSTIC-PARAMS — closes the gap discovered during
    // the provider-filter tests. The model lives in LEONARDO_MODELS
    // (UI config) and lib/model-specs/minimax-image-01.json (rich spec)
    // but was missing from this slimmer map that `param-suggest` reads,
    // so the rule engine returned an empty perModel entry for it.
    type: 'image',
    api_name: 'image-01',
    width: 1024,
    height: 1024,
    supported_sizes: ['1024x1024'],
    style_ids: false,
    prompt_enhance: 'ON',
    supports_image_reference: false,
  },
  'kling-3.0': {
    type: 'video',
    width: 1920,
    height: 1080,
    duration: 5,
    mode: 'RESOLUTION_1080',
    motion_has_audio: true,
    supports_start_frame: true,
    supports_end_frame: false,
  },
  'kling-o3': {
    type: 'video',
    api_name: 'kling-video-o-3',
    width: 1920,
    height: 1080,
    duration: 3,
    mode: 'RESOLUTION_1080',
    motion_has_audio: true,
    supports_start_frame: true,
    supports_end_frame: false,
  },
  'veo-3.1': {
    type: 'video',
    api_name: 'VEO3_1',
    width: 1920,
    height: 1080,
    duration: 8,
    mode: 'RESOLUTION_1080',
    supports_start_frame: true,
    supports_end_frame: true,
  },
  'seedance-2.0': {
    type: 'video',
    api_name: 'seedance-2.0',
    width: 1280,
    height: 720,
    duration: 8,
    mode: 'RESOLUTION_720',
    motion_has_audio: true,
    supports_start_frame: true,
    supports_end_frame: true,
  },
};

// Video model configs, analogous to LEONARDO_MODELS but carrying the
// duration/frame-support shape the pipeline and Compare tab need. Kept
// separate because image and video models don't share a UI list.
export interface LeonardoVideoModelConfig {
  id: string;
  name: string;
  apiModelId: string;
  duration: number;
  width: number;
  height: number;
  supportsStartFrame: boolean;
  supportsEndFrame: boolean;
  motionHasAudio: boolean;
}

export const LEONARDO_VIDEO_MODELS: LeonardoVideoModelConfig[] = [
  {
    id: 'kling-3.0',
    name: 'Kling 3.0',
    apiModelId: 'kling-3.0',
    duration: 5,
    width: 1920,
    height: 1080,
    supportsStartFrame: true,
    supportsEndFrame: false,
    motionHasAudio: true,
  },
  {
    id: 'kling-o3',
    name: 'Kling o3',
    apiModelId: 'kling-video-o-3',
    duration: 3,
    width: 1920,
    height: 1080,
    supportsStartFrame: true,
    supportsEndFrame: false,
    motionHasAudio: true,
  },
  {
    id: 'veo-3.1',
    name: 'Veo 3.1',
    apiModelId: 'VEO3_1',
    duration: 8,
    width: 1920,
    height: 1080,
    supportsStartFrame: true,
    supportsEndFrame: true,
    motionHasAudio: false,
  },
  {
    id: 'seedance-2.0',
    name: 'Seedance 2.0',
    apiModelId: 'seedance-2.0',
    duration: 8,
    width: 1280,
    height: 720,
    supportsStartFrame: true,
    supportsEndFrame: true,
    motionHasAudio: true,
  },
];

/** Get a Leonardo model config by its id */
export function getLeonardoModel(modelId: string): LeonardoModelConfig | undefined {
  return LEONARDO_MODELS.find(m => m.id === modelId || m.apiModelId === modelId);
}

/**
 * Display label for the *underlying* provider behind a Leonardo-routed model.
 * Used in the comparison-history badge so each column carries the actual
 * model family ("GEMINI" / "OPENAI") rather than a uniform "LEONARDO" — the
 * persisted `modelInfo.provider` is always 'leonardo' (the API broker) since
 * everything goes through /api/leonardo/*.
 *
 * Resolves on `id` first, then `apiModelId` (some persisted images store
 * the apiModelId variant). Unknown ids fall back to "LEONARDO" — the broker
 * is at least correct.
 */
export function getModelProviderLabel(modelId: string | undefined): string {
  if (!modelId) return 'LEONARDO';
  const id = modelId.toLowerCase();
  if (id.startsWith('nano-banana') || id.startsWith('gemini-')) return 'GEMINI';
  if (id.startsWith('gpt-image')) return 'OPENAI';
  return 'LEONARDO';
}

/** Get aspect ratio dimensions for a Leonardo model */
export function getLeonardoDimensions(modelId: string, aspectRatio: string): { width: number; height: number } {
  const model = getLeonardoModel(modelId);
  const ar = model?.aspectRatios.find(a => a.label === aspectRatio);
  return ar ? { width: ar.width, height: ar.height } : { width: 1024, height: 1024 };
}

export const ART_STYLES = [
  'Cinematic', 'Digital Art', 'Oil Painting', 'Cyberpunk', 'Sketch',
  'Hyper-realistic', 'Vibrant Anime', 'Dark Fantasy', 'Steampunk', 'Minimalist'
];

export const LIGHTING_OPTIONS = [
  'Golden Hour', 'Dramatic', 'Neon', 'Soft', 'Volumetric',
  'Studio Lighting', 'Moonlight', 'Harsh Sunlight', 'Bioluminescent', 'Ethereal'
];

export const CAMERA_ANGLES = [
  'Wide Shot', 'Close-up', 'Low Angle', 'Top-down', 'Bird\'s Eye',
  'Eye Level', 'Dutch Angle', 'Macro', 'Panoramic', 'Portrait'
];

export const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export const IMAGE_SIZES = ['1K', '2K', '4K'];

// ── Default Settings ────────────────────────────────────────────────────────

export const defaultSettings: UserSettings = {
  enabledProviders: ['leonardo'],
  apiKeys: {},
  defaultLeonardoModel: 'nano-banana-2',
  defaultAnimationDuration: 3,
  defaultAnimationStyle: 'DYNAMIC',
  defaultVideoModel: 'kling-video-o-3',
  // V1.1.1-MULTI-PROVIDER-VIDEO: new default is MiniMax (Hailuo 2.3)
  // instead of the v1.1.0 implicit-Leonardo behavior. The Settings
  // modal lets the user add or remove providers; the Animate button
  // fires parallel submissions to all selected ones.
  videoProviders: ['minimax'] as ('leonardo' | 'minimax' | 'higgsfield' | 'mmx')[],
  defaultMinimaxVideoModel: 'MiniMax-Hailuo-2.3',
  // V1.1.1-SKILLS-AUTO-USE: default to the banana-pro-director
  // skill (the SLCT + Skin Study cinematic-direction protocol) for
  // fresh installs. Users see the active list in Settings and
  // can toggle on/off.
  activeSkills: ['banana-pro-director'],
  antiAiLook: false,
  // V1.6: Director is the default pipeline path (was opt-in in v1.5.0).
  // Existing stores are flipped by applyV160DirectorDefaultMigration;
  // explicit user choices carry directorPipelineUserSet and win.
  useDirectorPipeline: true,
  cameraAngle: undefined,
  higgsfieldMonthlyCreditCap: undefined,
  watermark: {
    enabled: false,
    image: null,
    position: 'bottom-right',
    opacity: 0.8,
    scale: 0.15
  },
  agentNiches: [
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
    'Mythic Legends'
  ],
  agentGenres: [
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
    'Minimalist Design'
  ],
  // AI-ROLE-REDESIGN (2026-05-22): default persona dropped the
  // "precision prompt engineer" framing in favour of MashupForge AI
  // as a studio-wide co-pilot. NICHES / GENRES vocabulary moved to
  // Content Pillars / Style Tags. Settings keys (agentNiches,
  // agentGenres) unchanged so existing user prompts override this
  // default verbatim if they typed their own.
  agentPrompt: `You are MashupForge AI — the creative intelligence layer of a multi-model image generation studio. You operate across the full feature set (idea generation, prompt optimization, parameter suggestion, trend analysis, scheduling advice), not just prompt writing.

ORIENTATION:
- The user has configured Content Pillars (what they create around) and Style Tags (aesthetic / mood / visual direction). Those tags are your north star — adapt every suggestion to fit them. Never override the user's pillars with what you assume is popular.
- When prompts are needed: keep them SHORT and clean (40-60 words). Downstream prompt_enhance expands the detail. Character name + one equipment / scene fusion + brief setting + 1-2 quality tags is plenty.
- Tag every output's selectedNiches / selectedGenres from the active Content Pillars + Style Tags lists. Pick the 2-3 most relevant per output.
- Clean vocabulary. No graphic violence (no corpses, slaughter, gore, blood-soaked). Use milder alternatives: battle-scarred, aftermath of conflict, war-torn. The dark aesthetic comes from lighting and atmosphere, not body counts.

PROMPT QUALITY (when generating image prompts):
- Specific character names are fine where the user's Content Pillars cover them — the image API handles them. The trademark substitution layer downstream handles known-blocked names if any.
- Equipment fusions are the creative core — one compound invention blending the user's active pillars per prompt.
- Maximum variety across a batch — no repeated characters, different settings, different moods.`,
  channelName: 'MultiverseMashupAI',
  savedPersonalities: [],
  // LLM-INTEGRATION-0513: default fresh installs to the Vercel AI SDK
  // backend. It's stateless, has no subprocess/binary requirements, and
  // works on Vercel and Tauri/Node alike. Users without any API key
  // configured will see the unavailable state in Settings and can pick
  // pi/nca instead. Existing users keep whatever activeAiAgent their
  // IDB payload persisted — this only sets the new-install starting
  // value.
  activeAiAgent: 'vercel-ai',
  aiAgentProvider: 'vercel-ai',
};

// ── Context Type ────────────────────────────────────────────────────────────

export interface MashupContextType {
  isLoaded: boolean;
  view: ViewType;
  setView: (view: ViewType) => void;
  images: GeneratedImage[];
  setImages: React.Dispatch<React.SetStateAction<GeneratedImage[]>>;
  savedImages: GeneratedImage[];
  collections: Collection[];
  isGenerating: boolean;
  progress: string;
  settings: UserSettings;
  updateSettings: (newSettings: Partial<UserSettings> | ((prev: UserSettings) => Partial<UserSettings>)) => void;
  /** V1.1.1-CAMERA-ANGLE-CLEAR: explicit key-removal path. `updateSettings`
   *  intentionally strips `undefined` patches (so a partial update can
   *  say "leave this field alone" without clobbering defaults), which
   *  means a `{ cameraAngle: undefined }` patch never actually clears
   *  the field. The SettingsModal wires the CameraAnglePicker's "Clear"
   *  button through this method so the MCSLA C: fragment actually
   *  drops on the next render. Accepts an array so a future
   *  "Reset advanced settings" UI can clear multiple keys in one shot. */
  clearSettings: (keys: (keyof UserSettings)[]) => void;
  /** FEAT-002b S1: lifecycle of the debounced IndexedDB write so the
   *  SettingsModal can render a real save indicator (incl. red error
   *  pill on quota / disabled-storage failures). */
  settingsSaveState: import('../hooks/useSettings').SettingsSaveState;
  generateImages: (customPrompts?: string[], append?: boolean, options?: GenerateOptions) => Promise<void>;
  generatePostContent: (image: GeneratedImage) => Promise<GeneratedImage | undefined>;
  rerollImage: (id: string, prompt: string, options?: GenerateOptions) => Promise<void>;
  saveImage: (img: GeneratedImage) => void;
  deleteImage: (id: string, fromSaved: boolean) => void;
  /** #51: bulk-remove saved-image metadata in one store write (zombie cleanup). */
  removeImages: (ids: ReadonlySet<string>) => void;
  updateImageTags: (id: string, tags: string[]) => void;
  createCollection: (name?: string, description?: string, imageIds?: string[], savedImages?: GeneratedImage[]) => Promise<Collection>;
  bulkUpdateImageTags: (ids: string[], tags: string[], mode: 'append' | 'replace') => void;
  deleteCollection: (id: string) => void;
  addImageToCollection: (imageId: string, collectionId: string) => void;
  removeImageFromCollection: (imageId: string) => void;
  toggleApproveImage: (id: string) => void;
  generateComparison: (prompt: string, modelIds: string[], options?: GenerateOptions, cachedEnhancements?: Record<string, import('../hooks/useComparison').CachedEnhancement>) => Promise<GeneratedImage[]>;
  autoTagImage: (id: string, providedImg?: GeneratedImage) => Promise<void>;
  setImageStatus: (id: string, status: 'generating' | 'animating' | 'ready') => void;
  autoGenerateCollectionInfo: (sampleImages: GeneratedImage[] | string[]) => Promise<{ name: string; description: string } | null>;
  comparisonResults: GeneratedImage[];
  pickComparisonWinner: (id: string) => Promise<void>;
  clearComparison: () => void;
  deleteComparisonResult: (id: string) => void;
  generateNegativePrompt: (idea: string) => Promise<string>;
  comparisonPrompt: string;
  setComparisonPrompt: React.Dispatch<React.SetStateAction<string>>;
  comparisonOptions: GenerateOptions;
  setComparisonOptions: React.Dispatch<React.SetStateAction<GenerateOptions>>;
  generationError: string | null;
  clearGenerationError: () => void;
  comparisonError: string | null;
  clearComparisonError: () => void;
  ideas: Idea[];
  addIdea: (concept: string, context?: string) => void;
  updateIdeaStatus: (id: string, status: 'idea' | 'in-work' | 'done') => void;
  deleteIdea: (id: string) => void;
  clearIdeas: () => void;
  isSidebarOpen: boolean;
  setIsSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  // V1.2.1: lazy load triggers — see hooks/useImages.ts for the full
  // rationale. The Gallery/Collections/Ideas views call these on mount
  // so the Tauri plugin-store doesn't eagerly JSON.parse a 100+ MB
  // mashupforge.json at studio mount time. Studio mount sets isLoaded
  // immediately; the actual data hydrates when the user navigates to
  // the relevant view.
  requestImagesLoad: () => void;
  requestCollectionsLoad: () => void;
  requestIdeasLoad: () => void;
  requestSettingsLoad: () => void;
  requestComparisonLoad: () => void;
  pipelineEnabled: boolean;
  pipelineRunning: boolean;
  pipelineQueue: Idea[];
  pipelineProgress: PipelineProgress | null;
  pipelineLog: PipelineLogEntry[];
  pipelineDelay: number;
  setPipelineDelay: (delay: number) => void;
  togglePipeline: () => void;
  startPipeline: () => void;
  stopPipeline: () => void;
  /** Bail out of the in-flight idea without stopping the whole pipeline. */
  skipCurrentIdea: () => void;
  /** Continuous / daemon mode — keep regenerating ideas and posting on an interval. */
  pipelineContinuous: boolean;
  toggleContinuous: () => void;
  /** Minutes between daemon cycles when continuous mode is on. */
  pipelineInterval: number;
  setPipelineInterval: (minutes: number) => void;
  /** How many days ahead the daemon tries to keep the schedule filled. */
  pipelineTargetDays: number;
  setPipelineTargetDays: (days: number) => void;
  /** Ideas the daemon auto-generates per cycle when the queue is empty (1-10, default 5). */
  pipelineIdeasPerCycle: number;
  setPipelineIdeasPerCycle: (n: number) => void;
  /** Clear the pipeline log — leaves state/persistence intact otherwise. */
  clearPipelineLog: () => void;
  /** Approve a pending_approval post — flips its status to 'scheduled'. */
  approveScheduledPost: (postId: string) => void;
  /** Reject a pending_approval post — sets its status to 'rejected' (content stays visible). */
  rejectScheduledPost: (postId: string) => void;
  /** Bulk-approve N pending_approval posts in a single state pass. */
  bulkApproveScheduledPosts: (postIds: string[]) => void;
  /** Bulk-reject N pending_approval posts in a single state pass. */
  bulkRejectScheduledPosts: (postIds: string[]) => void;
  /**
   * V050-005: edit the caption of one or more scheduled posts in a
   * single state pass. Pass [postId] for a single post or
   * carousel.posts.map(p => p.id) for a carousel — every sibling
   * post in a carousel shares the same caption visually, so they
   * must update together to stay consistent.
   *
   * Also patches the matching CarouselGroup.caption (if any) so the
   * group's persisted caption stays in sync with its sibling posts.
   */
  updateScheduledPostsCaption: (postIds: string[], caption: string) => void;
  /** FEAT-006: surviving checkpoint from the previous run, if any.
   *  Set on mount when IDB has a record; null otherwise. */
  pendingResume: import('../lib/pipeline-checkpoint').PipelineCheckpoint | null;
  /** Accept the resume prompt — restart the pipeline from the saved idea. */
  acceptResume: () => void;
  /** Dismiss the resume prompt and drop the checkpoint. */
  dismissResume: () => void;
  /** V030-004: reactive week-fill status for the progress meter UI. */
  weekFillStatus: import('../lib/weekly-fill').WeekFillStatus;
}
