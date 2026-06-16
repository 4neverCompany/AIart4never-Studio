import React from 'react';
// 4NE-21 / Story 1.5: MiniMax monthly token-plan tier. Type-only re-use of
// the quota engine's tier union so Settings and the autonomy gate agree on
// the allowed values without redefining them here.
import type { MinimaxTier } from './../lib/minimax-quota';
// M1 CANON-WIRING: the active Master4never character id. Type-only re-use of
// the canon engine's union so Settings, the prompt route, and the director
// loop agree on the allowed character ids without redefining them here.
import type { CharacterId } from '@/lib/canon';

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
    // V1.1.1-MULTI-PROVIDER-VIDEO: includes `'mmx'` for the
    // multi-provider video path (the `mmx` provider in
    // settings.videoProviders is the CLI-based fallback). The
    // Studio's Animate button writes the matching provider id so
    // the gallery badge + post-lifecycle code can route correctly.
    // MashupForge rip: `'leonardo'` has been removed; the
    // settings-migration rewrites any persisted 'leonardo' badge to
    // 'higgsfield' on hydration so legacy gallery metadata stays valid.
    provider: 'minimax' | 'higgsfield' | 'mmx';
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
  /**
   * Image-pipeline provider override. Defaults to the active model's
   * `provider` field in LEONARDO_MODELS (`'minimax'` for the kept
   * minimax-image-01 entry). Set explicitly when the caller needs to
   * force a route; otherwise the model entry decides.
   *
   * MashupForge rip: the Leonardo engine has been removed. MiniMax
   * (/api/minimax-image) and Higgsfield (/api/higgsfield/image) are
   * the only image providers.
   */
  imageProvider?: 'minimax' | 'higgsfield';
  /** Model-id override (legacy name kept for call-site stability). */
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
  // MashupForge rip: the Leonardo image engine has been removed.
  // enabledProviders now lists the live image providers. The
  // settings-migration rewrites any persisted 'leonardo' entry to
  // 'minimax' on hydration.
  enabledProviders: ('minimax' | 'higgsfield')[];
  apiKeys: {
    /** Legacy Leonardo API key — preserved for IDB safety; no longer
     *  has a rendered control or a live code path (Leonardo OUT). */
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
   * idea→prompt step routes through the multi-step canon beat loop
   * (plan-beat → generate_prompt → critique → refine → generate_image) via
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
  /** 4NE-21 / Story 1.5: MiniMax Token-Plan tier. Drives the monthly
   * token allowance the autonomy-loop quota gate enforces
   * (`resolveAllowance(minimaxTier, minimaxCustomTokenCap)`). Default
   * 'plus'. Set to 'custom' to use `minimaxCustomTokenCap` as an explicit
   * cap; a 'custom' tier with no/zero cap means "track only, never block".
   * The token counter + auto-rollover live in `lib/minimax-quota.ts`. */
  minimaxTier?: MinimaxTier;
  /** 4NE-21 / Story 1.5: explicit monthly token cap, used only when
   * `minimaxTier` is 'custom'. Undefined / 0 = no cap (tracking only). */
  minimaxCustomTokenCap?: number;
  /**
   * M1 CANON-WIRING: the active Master4never canon character that shapes
   * every prompt / caption / plan. Drives `buildCanonSystemBlock` injection
   * into the text-mode system stack (`/api/ai/prompt`), the Director persona
   * (`lib/agent-loop/plan.ts`), and the image-prompt identity lock
   * (`buildCharacterLockBlock`). Optional for back-compat with stores that
   * pre-date canon wiring; the server defaults to `'kael'` (the protagonist /
   * narrator) when absent or invalid. Default in `defaultSettings` is 'kael'.
   */
  activeCharacterId?: CharacterId;
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
   * retired in v1.8.0 (see the handoff recon doc `m33-p3-recon-2026-06-12.md`).
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

export type ViewType = 'studio' | 'gallery' | 'captioning' | 'post-ready' | 'ideas' | 'pipeline';

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

// M1 CANON-NATIVE: the recommended Content Pillars are the Master4never
// canon pillars (see lib/canon CONTENT_PILLARS) plus the canon realities the
// beats are set in — NOT franchise/crossover/cosplay niches. The settings KEY
// stays `agentNiches` for back-compat; only the VALUES are canon.
export const RECOMMENDED_NICHES = [
  // The four canon content pillars (CONTENT_PILLARS names).
  'Story-Beat',
  'Variant Reveal',
  'Same Soul, Different Reality',
  'Lore / Poll',
  // The canon realities the beats live in (orient the beat without naming
  // any third-party franchise).
  'Cyberpunk PRIME',
  'Grimdark W40K',
  'Modern-Hightech W40K'
];

// M1 CANON-NATIVE: the recommended Style Tags are a tasteful canon set that
// suits the Master4never multiverse (cinematic netrunner + grimdark gothic
// sci-fi), NOT crossover/meme-mashup styles. KEY stays `agentGenres`.
export const RECOMMENDED_GENRES = [
  'Cinematic',
  'Grimdark',
  'Character Study',
  'Neo-Noir',
  'Netrunner Cyberpunk',
  'Gothic Sci-Fi',
  'Dramatic Lighting',
  'Hyper-Detailed',
  'Volumetric Atmosphere',
  'Painterly Concept Art'
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
   * Backend provider. `'minimax'` routes the request to
   * `/api/minimax-image` and uses MiniMax's `image_generation`
   * endpoint; the `apiModelId` is then the MiniMax model name
   * (e.g. `'image-01'`). MashupForge rip: `'leonardo'` has been
   * removed — the kept entry is the MiniMax image model.
   */
  provider?: 'minimax';
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

// MashupForge rip: the Leonardo image catalog (nano-banana, nano-banana-2,
// nano-banana-pro, gpt-image-1.5, gpt-image-2 — all provider:'leonardo')
// has been removed. The array name is retained because it is the kept,
// non-Leonardo home for the MiniMax image model and is imported by the
// Studio model pickers, useComparison, param-suggest, and image-models.
export const LEONARDO_MODELS: LeonardoModelConfig[] = [
  {
    id: 'minimax-image-01',
    name: 'MiniMax Image-01',
    // MiniMax's own `image_generation` endpoint. The route
    // /api/minimax-image forwards to
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
 * Per-model prompt engineering guides, keyed by LEONARDO_MODELS[].id.
 * The Director / Compare flow looks up the guide for the target model
 * (a missing key simply means "no model-specific guide").
 *
 * MashupForge rip: the Leonardo-catalog guides (nano-banana*,
 * gpt-image-*) were removed with their models. The live MiniMax +
 * Higgsfield models carry their guidance through model-specs JSON and
 * the Higgsfield skill bindings instead, so this map is currently empty
 * but kept so existing `modelGuides` consumers compile unchanged.
 */
export const MODEL_PROMPT_GUIDES: Record<string, string> = {};

// V030-007-followup: Authoritative per-model API parameter spec from
// Maurice's model-params.json. This is the source of truth for what
// the image API actually accepts per model — width/height, supported
// sizes, quality levels, durations, and frame capabilities. Consumed by
// the kept image-models / useComparison paths to avoid sending values
// the API will reject. (The compare-view param-suggest layer that also
// read this map was removed in the AIart4never compare-view rip.)
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
  // MashupForge rip: the Leonardo image/video param specs (gpt-image-*,
  // nano-banana-*, kling-*, veo-*, seedance-*) were removed with their
  // models. Only the kept MiniMax image model remains. `param-suggest`
  // reads this slimmer map; missing keys yield an empty perModel entry.
  'minimax-image-01': {
    type: 'image',
    api_name: 'image-01',
    width: 1024,
    height: 1024,
    supported_sizes: ['1024x1024'],
    style_ids: false,
    prompt_enhance: 'ON',
    supports_image_reference: false,
  },
};

/** Get a model config by its id (kept name; the array now holds the
 *  MiniMax image model after the Leonardo rip). */
export function getLeonardoModel(modelId: string): LeonardoModelConfig | undefined {
  return LEONARDO_MODELS.find(m => m.id === modelId || m.apiModelId === modelId);
}

/**
 * Display label for the *underlying* provider/model family behind a
 * persisted gallery image. Used in the comparison-history badge so a
 * column carries the actual model family. After the MashupForge rip the
 * live providers are MiniMax + Higgsfield; legacy persisted ids that
 * predate the rip still map to their historical family label.
 *
 * Resolves on `id` (or the apiModelId some persisted images store).
 * Unknown ids fall back to "MINIMAX" — the kept default image provider.
 */
export function getModelProviderLabel(modelId: string | undefined): string {
  if (!modelId) return 'MINIMAX';
  const id = modelId.toLowerCase();
  if (id.startsWith('nano-banana') || id.startsWith('gemini-')) return 'GEMINI';
  if (id.startsWith('gpt-image')) return 'OPENAI';
  if (id.startsWith('minimax') || id.startsWith('image-01')) return 'MINIMAX';
  if (id.startsWith('higgsfield') || id.startsWith('seedance') || id.startsWith('kling')) return 'HIGGSFIELD';
  return 'MINIMAX';
}

/** Get aspect ratio dimensions for a model (kept name post-rip) */
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
  enabledProviders: ['minimax'],
  apiKeys: {},
  // Legacy field kept for IDB safety; defaults to the kept MiniMax
  // image model now that Leonardo specs are gone.
  defaultLeonardoModel: 'minimax-image-01',
  defaultAnimationDuration: 3,
  defaultAnimationStyle: 'DYNAMIC',
  defaultVideoModel: 'kling-video-o-3',
  // V1.1.1-MULTI-PROVIDER-VIDEO: default is MiniMax (Hailuo 2.3). The
  // Settings modal lets the user add or remove providers; the Animate
  // button fires parallel submissions to all selected ones. Leonardo
  // is no longer a video provider (engine removed).
  videoProviders: ['minimax'] as ('minimax' | 'higgsfield' | 'mmx')[],
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
  // 4NE-21 / Story 1.5: default to the 'plus' tier so the monthly token
  // quota is tracked + enforced out of the box. The user can switch tier
  // (or set a custom cap) in Settings → Token Quota.
  minimaxTier: 'plus',
  minimaxCustomTokenCap: undefined,
  // M1 CANON-WIRING: default to Kael — the Master4never protagonist / narrator.
  // Every prompt / caption / plan is shaped by this character's canon block.
  activeCharacterId: 'kael',
  watermark: {
    enabled: false,
    image: null,
    position: 'bottom-right',
    opacity: 0.8,
    scale: 0.15
  },
  // M1 CANON-NATIVE: fresh installs default to the Master4never canon pillars
  // + realities (NOT crossover/cosplay niches). Settings KEYS unchanged for
  // back-compat; mirrors RECOMMENDED_NICHES.
  agentNiches: [
    'Story-Beat',
    'Variant Reveal',
    'Same Soul, Different Reality',
    'Lore / Poll',
    'Cyberpunk PRIME',
    'Grimdark W40K',
    'Modern-Hightech W40K'
  ],
  // M1 CANON-NATIVE: canon-appropriate styles (mirrors RECOMMENDED_GENRES).
  agentGenres: [
    'Cinematic',
    'Grimdark',
    'Character Study',
    'Neo-Noir',
    'Netrunner Cyberpunk',
    'Gothic Sci-Fi',
    'Dramatic Lighting',
    'Hyper-Detailed',
    'Volumetric Atmosphere',
    'Painterly Concept Art'
  ],
  // AI-ROLE-REDESIGN (2026-05-22): default persona dropped the
  // "precision prompt engineer" framing in favour of AIart4never Studio AI
  // as a studio-wide co-pilot. NICHES / GENRES vocabulary moved to
  // Content Pillars / Style Tags. Settings keys (agentNiches,
  // agentGenres) unchanged so existing user prompts override this
  // default verbatim if they typed their own.
  agentPrompt: `You are AIart4never Studio AI — the creative intelligence layer of a multi-model image generation studio. You operate across the full feature set (idea generation, prompt optimization, parameter suggestion, trend analysis, scheduling advice), not just prompt writing.

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
}
