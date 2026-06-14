/**
 * Weekly Sunday recap orchestration.
 *
 * Each Sunday at 10:00 the cron workflow hits /api/cron/sunday-recap with
 * the user's posts from the last 7 days. The route delegates to:
 *
 *   planRecap(posts, opts)  -> a RecapPlan (pure function, deterministic,
 *                               hot-path of all unit tests)
 *   executeRecap(plan, opts) -> spawns mmx three times (video, music,
 *                               speech) and returns artifact handles
 *
 * The "AI art 4never avatar" voiceover style — warm, enthusiastic,
 * slightly dramatic — is baked into AVATAR_VOICE_PROFILE below. It biases
 * voice choice + appends stage directions to the script so the speech
 * model leans into that delivery.
 *
 * NOT done in this module: combining the three artifacts into a single
 * clip (that needs ffmpeg or similar; deliberately out of scope here),
 * and posting the combined clip to social. The route returns the
 * artifacts and the next slice can wire combination + auto-post.
 */

import { join } from 'node:path';
import {
  generateVideo,
  generateMusic,
  synthesizeSpeech,
  type MmxVideoOptions,
  type MmxMusicOptions,
  type MmxSpeechOptions,
} from './mmx-client';

export interface RecapPost {
  id: string;
  /** Anything Date(...) can parse — ISO 8601 or YYYY-MM-DD. */
  date: string;
  /** Free-text caption. May be empty. */
  caption: string;
  /** Platform names where this was posted. Used for filtering / context. */
  platforms?: string[];
  /** Optional explicit hashtag list (without "#" prefix). Falls back to
   * scanning the caption when omitted. */
  hashtags?: string[];
}

export interface RecapPlan {
  /** Prompt fed to mmx video generate. */
  videoPrompt: string;
  /** Prompt fed to mmx music generate. */
  musicPrompt: string;
  /** Text fed to mmx speech synthesize. */
  voiceoverScript: string;
  /** Top-N topics extracted from posts. UI / logging consumer. */
  topics: string[];
  /** Total posts the route was given. */
  postsConsidered: number;
  /** Posts that fell inside the rolling window. */
  postsInWindow: number;
  /** ISO date string at the start of the window. */
  windowStart: string;
  /** ISO date string at the end of the window (= now). */
  windowEnd: string;
}

export interface RecapPlanOptions {
  /** Reference "now". Defaults to new Date(). Tests pin this for determinism. */
  now?: Date;
  /** Look-back window in days. Defaults to 7. */
  windowDays?: number;
  /** Cap on extracted topics. Defaults to 5. */
  maxTopics?: number;
}

/**
 * AI Art 4never avatar voice profile. Maurice's brand voice for the
 * weekly recap voiceover: warm, enthusiastic, slightly dramatic narrator.
 * The mmx default voice is English_expressive_narrator which already
 * leans expressive; we keep it explicit so a future voice swap is one
 * constant change.
 */
export const AVATAR_VOICE_PROFILE: Required<Pick<MmxSpeechOptions, 'voice' | 'speed' | 'pitch'>> = {
  voice: 'English_expressive_narrator',
  speed: 1.0,
  pitch: 0,
};

const HASHTAG_RE = /(?:^|\s)#([A-Za-z][\w-]{0,40})/g;

/** Pull explicit hashtag list, or scan the caption text as a fallback. */
function tagsFromPost(post: RecapPost): string[] {
  if (post.hashtags && post.hashtags.length > 0) {
    return post.hashtags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
  }
  const tags: string[] = [];
  for (const m of post.caption.matchAll(HASHTAG_RE)) tags.push(m[1]);
  return tags;
}

/** Count occurrences and return the N most frequent, ties broken by first
 * occurrence (stable). */
function topByFrequency(items: string[], n: number): string[] {
  const counts = new Map<string, { count: number; firstAt: number }>();
  items.forEach((raw, i) => {
    const key = raw.toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.count += 1;
    else counts.set(key, { count: 1, firstAt: i });
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1].count - a[1].count || a[1].firstAt - b[1].firstAt)
    .slice(0, n)
    .map(([key]) => key);
}

/**
 * Build the recap plan from a post window. Pure / deterministic given
 * `opts.now` — no I/O, no spawn, no network.
 */
export function planRecap(posts: RecapPost[], opts: RecapPlanOptions = {}): RecapPlan {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 7;
  const maxTopics = opts.maxTopics ?? 5;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const inWindow = posts.filter((p) => {
    const t = Date.parse(p.date);
    if (Number.isNaN(t)) return false;
    return t >= windowStart.getTime() && t <= now.getTime();
  });

  const allTags = inWindow.flatMap(tagsFromPost);
  const topics = topByFrequency(allTags, maxTopics);
  const topicsLine = topics.length > 0 ? topics.join(', ') : 'this week\'s creations';

  const videoPrompt =
    `Cinematic recap montage of an AI art creator's week. ` +
    `Visual themes: ${topicsLine}. ` +
    `Energetic camera moves, warm color grade, flashes of artwork, end card "AI art 4never".`;

  const musicPrompt =
    `Upbeat instrumental theme for a weekly creator recap. ` +
    `Warm and enthusiastic, slightly dramatic build, modern electronic with cinematic strings.`;

  const voiceoverScript = buildVoiceoverScript(inWindow.length, topics);

  return {
    videoPrompt,
    musicPrompt,
    voiceoverScript,
    topics,
    postsConsidered: posts.length,
    postsInWindow: inWindow.length,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
  };
}

/** Build the AI art 4never avatar voiceover script. Warm, enthusiastic,
 * slightly dramatic — short pauses cued via comma + ellipsis, high-energy
 * opener, an arc through the topics, and a closing tag. */
function buildVoiceoverScript(postCount: number, topics: string[]): string {
  const intro =
    postCount === 0
      ? `Hey friends... what a week.`
      : postCount === 1
        ? `Hey friends — one piece this week, and oh, what a piece it was.`
        : `Hey friends — ${postCount} new pieces this week, and oh, what a week it was.`;

  let topicsBeat: string;
  if (topics.length === 0) {
    topicsBeat = `From quiet experiments to bold mashups, every post pushed the style further.`;
  } else if (topics.length === 1) {
    topicsBeat = `We leaned hard into ${topics[0]} — and the results... speak for themselves.`;
  } else {
    const last = topics[topics.length - 1];
    const head = topics.slice(0, -1).join(', ');
    topicsBeat = `We rode the wave of ${head}, and finished strong on ${last} — every piece a little bolder than the last.`;
  }

  const outro = `Thank you for being here. New drops next week. AI art 4never.`;

  return `${intro} ${topicsBeat} ${outro}`;
}

// ---------------------------------------------------------------------------
// Execution layer
// ---------------------------------------------------------------------------

export interface RecapExecutionOptions {
  /** Directory mmx writes its music + voiceover artifacts into. The cron
   * route uses a per-request mkdtempSync; tests pass a fixed dir. */
  outDir: string;
  /** Optional override of the video opts (e.g. firstFrame asset). */
  videoOptions?: MmxVideoOptions;
  /** Optional override of the music opts. */
  musicOptions?: MmxMusicOptions;
  /** Optional override of the voice profile. Defaults to AVATAR_VOICE_PROFILE. */
  speechOptions?: MmxSpeechOptions;
  /** Forwarded to each mmx call. */
  signal?: AbortSignal;
}

export interface RecapArtifacts {
  videoTaskId?: string;
  videoPath?: string;
  musicPath?: string;
  voiceoverPath?: string;
  /** Per-stage failures. Stages are independent: a failure in one does
   * not block the others. */
  errors: Array<{ stage: 'video' | 'music' | 'voiceover'; message: string }>;
}

/**
 * Run the three mmx generations in parallel. Each is independent — a
 * failure in one stage is recorded but does not abort the others, so a
 * partial recap (music + voiceover, no video) is still useful and the
 * cron run can report what worked.
 *
 * Video uses `--no-wait` by default: video is async and waiting risks
 * timing the cron run out. Caller polls separately if needed.
 */
export async function executeRecap(
  plan: RecapPlan,
  opts: RecapExecutionOptions,
): Promise<RecapArtifacts> {
  const errors: RecapArtifacts['errors'] = [];

  const musicPath = join(opts.outDir, 'recap-music.mp3');
  const voicePath = join(opts.outDir, 'recap-voice.mp3');

  const speechOpts: MmxSpeechOptions = {
    ...AVATAR_VOICE_PROFILE,
    ...opts.speechOptions,
    out: voicePath,
  };
  const musicOpts: MmxMusicOptions = {
    instrumental: true,
    mood: 'warm enthusiastic dramatic',
    useCase: 'weekly creator recap',
    ...opts.musicOptions,
    out: musicPath,
  };
  const videoOpts: MmxVideoOptions = {
    noWait: true,
    ...opts.videoOptions,
  };

  const [videoSettled, musicSettled, voiceSettled] = await Promise.allSettled([
    generateVideo(plan.videoPrompt, videoOpts, { signal: opts.signal }),
    generateMusic(plan.musicPrompt, musicOpts, { signal: opts.signal }),
    synthesizeSpeech(plan.voiceoverScript, speechOpts, { signal: opts.signal }),
  ]);

  const out: RecapArtifacts = { errors };

  if (videoSettled.status === 'fulfilled') {
    out.videoTaskId = videoSettled.value.taskId;
    out.videoPath = videoSettled.value.path;
  } else {
    errors.push({ stage: 'video', message: errMessage(videoSettled.reason) });
  }
  if (musicSettled.status === 'fulfilled') {
    out.musicPath = musicSettled.value.path;
  } else {
    errors.push({ stage: 'music', message: errMessage(musicSettled.reason) });
  }
  if (voiceSettled.status === 'fulfilled') {
    out.voiceoverPath = voiceSettled.value.path;
  } else {
    errors.push({ stage: 'voiceover', message: errMessage(voiceSettled.reason) });
  }

  return out;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'unknown error';
}
