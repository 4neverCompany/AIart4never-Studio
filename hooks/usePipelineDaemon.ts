'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { streamAIToString, extractJsonArrayFromLLM, extractJsonObjectFromLLM } from '@/lib/aiClient';
import {
  type Idea,
  type UserSettings,
  type GeneratedImage,
  type PipelineLogEntry,
  type PipelineProgress,
  type ScheduledPost,
} from '../types/mashup';
import {
  fetchInstagramEngagement,
  loadEngagementData,
  type CachedEngagement,
  type EngagementHour,
} from '@/lib/smartScheduler';
import { getErrorMessage } from '@/lib/errors';
import { fetchWithRetry } from '@/lib/fetchWithRetry';
import { MASHUPFORGE_AI_PERSONA } from '@/lib/agent-prompt';
import { setPipelineBusy } from '@/lib/pipeline-busy';
import {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  type PipelineCheckpoint,
} from '@/lib/pipeline-checkpoint';
import { SkipIdeaSignal, type ResumeContext } from '@/lib/pipeline-processor';
import { withPipelineRunning } from '@/lib/pipeline-runner';
import {
  savePipelineLog,
  loadPipelineLog,
  clearPipelineLog as clearPipelineLogStore,
} from '@/lib/pipeline-log-store';
import { IdeaTimeoutError, pickContinuousBranch } from '@/lib/pipeline-daemon-utils';
import { computeWeekFillStatus, type WeekFillStatus } from '@/lib/weekly-fill';

const PIPELINE_STORAGE_KEY = 'mashup_pipeline_state';

interface PersistedPipelineConfig {
  enabled: boolean;
  delay: number;
  continuous: boolean;
  interval: number;
  targetDays: number;
  ideasPerCycle: number;
}

function loadPersistedConfig(): PersistedPipelineConfig {
  try {
    const raw = localStorage.getItem(PIPELINE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        enabled: parsed.enabled ?? false,
        delay: parsed.delay ?? 30,
        continuous: parsed.continuous ?? false,
        interval: parsed.interval ?? 120,
        targetDays: parsed.targetDays ?? 7,
        ideasPerCycle: parsed.ideasPerCycle ?? 5,
      };
    }
  } catch {
    /* ignore */
  }
  return {
    enabled: false,
    delay: 30,
    continuous: false,
    interval: 120,
    targetDays: 7,
    ideasPerCycle: 5,
  };
}

function persistConfig(state: PersistedPipelineConfig) {
  try {
    localStorage.setItem(PIPELINE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** V030-002: hard cap per idea so a stuck step can't pin the daemon. */
const PER_IDEA_TIMEOUT_MS = 10 * 60 * 1000;

export type WriteCheckpointBase = (
  ideaId: string,
  concept: string,
  step: string,
  imageIds: readonly string[],
) => void;

export type ProcessIdeaFn = (
  idea: Idea,
  index: number,
  total: number,
  engagement: CachedEngagement,
  accumulatedPosts: ScheduledPost[],
  skipSignal: AbortSignal,
  writeCheckpointBase: WriteCheckpointBase,
  resumeFrom?: ResumeContext,
) => Promise<void>;

/**
 * V050-001: credit-preserving resume hint forwarded from acceptResume into
 * the daemon's outer loop. The hint is consumed by the FIRST matching idea
 * (by id) processed during this run; subsequent ideas run normally.
 */
export interface PipelineResumeHint {
  ideaId: string;
  images: GeneratedImage[];
}

export interface UsePipelineDaemonDeps {
  ideas: Idea[];
  settings: UserSettings;
  images: GeneratedImage[];
  savedImages: GeneratedImage[];
  /**
   * V082-FIX-SETTINGS-HYDRATE: settings are loaded from IDB on mount
   * via useSettings. Until isSettingsLoaded flips true, `settings` is
   * the default (empty scheduledPosts), and any pre-cycle fill check
   * would see "0/7 posts, not full" — generating a fresh cycle on a
   * week that's already been published. The daemon tracks this so
   * the pre-cycle block in runOuterLoop can wait for hydration
   * before making the start/no-start decision.
   *
   * Optional with a default of `true` so existing tests + callers
   * that don't yet thread isSettingsLoaded through keep working
   * (the new auto-start gate is opt-in via the dep).
   */
  isSettingsLoaded?: boolean;
  addIdea: (concept: string, context?: string) => void;
  updateIdeaStatus: (id: string, status: 'idea' | 'in-work' | 'done') => void;
}

/**
 * Pipeline daemon hook. Owns all pipeline state, the outer cycle loop,
 * checkpoint storage, and user-facing run controls.
 *
 * V030-001: refs reduced from 8 sync pairs to 1 consolidated latestPropsRef
 * (documented exception for live reads of parent props — see spec §4.3).
 * All daemon-owned state reads use functional setState peek; stop/skip
 * signals use AbortController held in useState.
 */
export function usePipelineDaemon(deps: UsePipelineDaemonDeps) {
  const { addIdea, updateIdeaStatus } = deps;
  // Default true so existing tests/callers that haven't yet threaded
  // isSettingsLoaded through don't see a behavioural change.
  const isSettingsLoaded = deps.isSettingsLoaded ?? true;

  const [pipelineEnabled, setPipelineEnabled] = useState(
    () => loadPersistedConfig().enabled,
  );
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineQueue, setPipelineQueue] = useState<Idea[]>([]);
  const [pipelineProgress, setPipelineProgress] = useState<PipelineProgress | null>(null);
  // V030-003: log hydrates from IDB on mount (async — starts empty).
  const [pipelineLog, setPipelineLog] = useState<PipelineLogEntry[]>([]);
  const [pipelineDelay, setPipelineDelayState] = useState(() => loadPersistedConfig().delay);
  const [pipelineContinuous, setPipelineContinuous] = useState(
    () => loadPersistedConfig().continuous,
  );
  const [pipelineInterval, setPipelineIntervalState] = useState(
    () => loadPersistedConfig().interval,
  );
  const [pipelineTargetDays, setPipelineTargetDaysState] = useState(
    () => loadPersistedConfig().targetDays,
  );
  // PIPELINE-CONT-V2: configurable ideas/cycle (default 5, range 1-10).
  // Old behaviour was a hardcoded 3 inside autoGenerateIdeas — too few to
  // sustain a full week when posts can be rejected or fail approval.
  const [pipelineIdeasPerCycle, setPipelineIdeasPerCycleState] = useState(
    () => loadPersistedConfig().ideasPerCycle,
  );
  const [pendingResume, setPendingResume] = useState<PipelineCheckpoint | null>(null);
  // AbortControllers — signal.aborted is a live read on the shared object,
  // so no ref needed. Held in useState so stop/skip handlers can reach the
  // current one via functional setState peek.
  const [runCtrl, setRunCtrl] = useState<AbortController | null>(null);
  const [skipCtrl, setSkipCtrl] = useState<AbortController | null>(null);

  // § 4.3 documented exception: ONE consolidated ref + ONE useEffect, replacing
  // the 8 per-field ref/useEffect pairs in the old god hook. Live reads of
  // parent-owned values (ideas, settings, images, savedImages) must go through
  // this — long-running async loops can't close over React props without it.
  const latestPropsRef = useRef({
    ideas: deps.ideas,
    settings: deps.settings,
    images: deps.images,
    savedImages: deps.savedImages,
  });
  useEffect(() => {
    latestPropsRef.current = {
      ideas: deps.ideas,
      settings: deps.settings,
      images: deps.images,
      savedImages: deps.savedImages,
    };
  }, [deps.ideas, deps.settings, deps.images, deps.savedImages]);

  const getIdeas = useCallback(() => latestPropsRef.current.ideas, []);
  const getSettings = useCallback(() => latestPropsRef.current.settings, []);
  const getImages = useCallback(() => latestPropsRef.current.images, []);

  // V082-FIX-SETTINGS-HYDRATE: live ref so the runOuterLoop async
  // loop (which captures `deps` once on entry) can re-evaluate the
  // settings-hydration gate every cycle. On a cold mount, settings
  // start as defaultSettings (empty scheduledPosts); the pre-cycle
  // check in runOuterLoop sees "0/7 not full" and tries to generate.
  // Blocking the first pre-cycle check until isSettingsLoaded flips
  // true is the last line of defense — usePipeline's auto-start
  // effect is the first.
  const settingsLoadedRef = useRef(isSettingsLoaded);
  useEffect(() => {
    settingsLoadedRef.current = isSettingsLoaded;
  }, [isSettingsLoaded]);

  // Publish busy flag so UpdateChecker (outside MashupProvider) can postpone
  // auto-install while a run is in flight.
  useEffect(() => {
    setPipelineBusy(pipelineRunning);
  }, [pipelineRunning]);

  // Hydrate resume prompt on mount.
  useEffect(() => {
    let cancelled = false;
    void loadCheckpoint().then(cp => {
      if (cancelled || !cp) return;
      setPendingResume(cp);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // V030-003: hydrate log from IDB on mount so crash-survived entries are
  // visible before the first run.
  useEffect(() => {
    let cancelled = false;
    void loadPipelineLog().then(entries => {
      if (cancelled || entries.length === 0) return;
      setPipelineLog(entries);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist config to localStorage (small, sync, no blobs).
  useEffect(() => {
    persistConfig({
      enabled: pipelineEnabled,
      delay: pipelineDelay,
      continuous: pipelineContinuous,
      interval: pipelineInterval,
      targetDays: pipelineTargetDays,
      ideasPerCycle: pipelineIdeasPerCycle,
    });
  }, [
    pipelineEnabled,
    pipelineDelay,
    pipelineContinuous,
    pipelineInterval,
    pipelineTargetDays,
    pipelineIdeasPerCycle,
  ]);

  // V030-003: persist log to IDB on every change (fire-and-forget; best-effort).
  useEffect(() => {
    void savePipelineLog(pipelineLog);
  }, [pipelineLog]);

  const addLog = useCallback(
    (
      step: string,
      ideaId: string,
      status: 'success' | 'error',
      message: string,
    ) => {
      setPipelineLog(prev => {
        const next = [...prev, { timestamp: new Date(), step, ideaId, status, message }];
        return next.length > 50 ? next.slice(-50) : next;
      });
    },
    [],
  );

  const autoGenerateIdeas = useCallback(async (count: number): Promise<Idea[]> => {
    const s = latestPropsRef.current.settings;
    const themed = s.pipelineThemedBatches ?? false;

    // TREND-DRIVEN-IDEAS (2026-05-21): fetch trending research keyed by
    // the user's active niches/genres BEFORE asking the AI for concepts.
    // Without this, daemon-auto-gen saw only static niche/genre lists and
    // produced evergreen but un-timely ideas. /api/trending falls back
    // to niche/genre-only queries when ideaConcept is empty (see
    // app/api/trending/route.ts:211 — `if (ideaConcept)` branch is
    // skipped, freshTerms + crossoverTerms drive the search). The
    // resulting blurb is injected into the system prompt so the AI can
    // bias concept selection toward what's actually trending in the
    // user's franchises right now. Sidebar idea-gen already follows
    // this pattern (components/Sidebar.tsx ~200); this brings the
    // autonomous daemon in line.
    //
    // Failure mode: trending fetch errors fall through with an empty
    // blurb. AI still gets niches/genres; we just lose the timeliness
    // signal for that cycle. Same prompt template either way so the AI
    // doesn't see a half-broken context.
    let trendingBlurb = '';
    try {
      const res = await fetchWithRetry('/api/trending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tags: [],
          niches: s.agentNiches,
          genres: s.agentGenres,
          ideaConcept: '',
        }),
      });
      const data = (await res.json()) as { success?: boolean; summary?: string };
      if (data.success && data.summary) trendingBlurb = data.summary;
    } catch {
      // Best-effort — daemon continues without trending signal.
    }
    const trendingBlock = trendingBlurb
      ? `\nTrending right now in the user's active franchises (use this to drive concept picks if relevant — recent releases, fan reactions, crossover potential):\n${trendingBlurb}\n`
      : '';

    // AI-ROLE-REDESIGN (2026-05-22): Content Pillars / Style Tags
    // labels + MashupForge AI persona fallback. agentNiches /
    // agentGenres keys unchanged for storage back-compat.
    const base = `${s.agentPrompt || MASHUPFORGE_AI_PERSONA}
Content Pillars: ${s.agentNiches?.join(', ') || 'All — pick freely'}
Style Tags: ${s.agentGenres?.join(', ') || 'All — pick freely'}${trendingBlock}`;

    const systemContext = themed
      ? `${base}

Pick ONE specific, unifying theme that fits the Content Pillars + Style Tags — a single crossover universe pairing, era mashup, visual motif, or narrative angle. Then generate ${count} variations that all riff on that same theme from different angles (different characters, scenes, moods, or compositions within the theme).

The theme should be concrete, not generic — e.g. "Retro Saturday Morning Cartoons × Cosmic Horror" is good, "cool mashups" is not.

Return ONLY a JSON object with:
- "theme": the one-line shared theme (used as the shared context for every variation)
- "variations": array of ${count} objects, each with a "concept" field (the specific image idea within the theme)

Example:
{"theme":"Retro Saturday Morning Cartoons × Cosmic Horror","variations":[
  {"concept":"Scooby-Doo gang investigating a non-euclidean haunted mansion, Lovecraftian tentacles seeping through the walls"},
  {"concept":"The Muppets performing a ritual in a candlelit theatre, Kermit chanting from a Necronomicon"},
  {"concept":"Looney Tunes characters as cultists worshipping a cosmic Acme entity, Bugs Bunny in dark robes"}
]}`
      : `${base}

Generate ${count} unique, creative content ideas for social media posts.
Each idea should be visually striking, shareable, and aligned with the Content Pillars + Style Tags above.
Return ONLY a JSON array of objects with "concept" and "context" fields. Example:
[{"concept": "Darth Vader as a grimdark Warhammer inquisitor...", "context": "Star Wars × WH40k crossover"}]`;

    const text = await streamAIToString(systemContext, {
      mode: 'idea',
      niches: s.agentNiches,
      genres: s.agentGenres,
      provider: s.activeAiAgent,
    });

    const nowStamp = Date.now();
    const buildIdea = (concept: string, context: string, i: number): Idea => ({
      id: `idea-auto-${nowStamp}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      concept: concept.trim(),
      context: context.trim(),
      status: 'idea' as const,
      createdAt: nowStamp,
    });

    if (themed) {
      const parsed = extractJsonObjectFromLLM(text);
      const theme = typeof parsed.theme === 'string' ? parsed.theme.trim() : '';
      const variations = Array.isArray(parsed.variations)
        ? (parsed.variations as unknown[])
        : [];
      const ideasOut = variations
        .filter(
          (v): v is Record<string, unknown> =>
            typeof v === 'object' &&
            v !== null &&
            typeof (v as Record<string, unknown>).concept === 'string' &&
            Boolean((v as Record<string, unknown>).concept),
        )
        .map((v, i) =>
          buildIdea(
            String(v.concept),
            theme
              ? `Theme: ${theme}${v.context ? ` — ${v.context}` : ''}`
              : typeof v.context === 'string'
                ? v.context
                : '',
            i,
          ),
        );
      if (ideasOut.length > 0) return ideasOut;
    }

    const parsed = extractJsonArrayFromLLM(text);
    return parsed
      .filter(
        (idea): idea is Record<string, unknown> =>
          typeof idea === 'object' &&
          idea !== null &&
          typeof (idea as Record<string, unknown>).concept === 'string' &&
          Boolean((idea as Record<string, unknown>).concept),
      )
      .map((idea, i) =>
        buildIdea(
          String(idea.concept),
          typeof idea.context === 'string' ? idea.context : '',
          i,
        ),
      );
  }, []);

  /**
   * Runs the outer pipeline loop end-to-end: engagement fetch,
   * one-or-many cycles of idea processing, continuous-mode sleep, cleanup.
   * Caller provides processIdea (built by useIdeaProcessor).
   *
   * Live-value reads inside the loop go through functional setState peek or
   * latestPropsRef — no per-field refs are created here.
   */
  const runOuterLoop = useCallback(
    (processIdea: ProcessIdeaFn, resumeHint?: PipelineResumeHint): Promise<void> =>
      withPipelineRunning(setPipelineRunning, async () => {
        // Fresh AbortControllers for this run.
        const runAbort = new AbortController();
        setRunCtrl(runAbort);

        // V050-001: scoped to this run. Cleared after the matching idea is
        // dispatched so subsequent ideas (and subsequent cycles in
        // continuous mode) run normally.
        let pendingResumeHint: PipelineResumeHint | undefined = resumeHint;

        // V030-004: one-shot latch so the week-filled event logs at most
        // once per run, not every sleep cycle.
        let weekFilledPromptedThisRun = false;

        // Snapshot settings at run start for checkpoint continuity. Captured
        // in a local so writeCheckpointBase closes over stable values — no ref.
        const snapshotSettings: PipelineCheckpoint['settings'] = {
          delay: pipelineDelay,
          continuous: pipelineContinuous,
          interval: pipelineInterval,
          targetDays: pipelineTargetDays,
        };
        const writeCheckpointBase: WriteCheckpointBase = (
          ideaId,
          concept,
          step,
          imageIds,
        ) => {
          void saveCheckpoint({
            ideaId,
            step,
            concept,
            ts: new Date().toISOString(),
            settings: snapshotSettings,
            imageIds: [...imageIds],
          });
        };

        setPendingResume(null);
        addLog(
          'pipeline-start',
          '',
          'success',
          `Pipeline started${pipelineContinuous ? ' (continuous mode)' : ''}`,
        );

        // M3.3-P3 commit c: the pi.dev pre-check is gone with the pi
        // routes. A failed vercel-ai call now surfaces through the
        // existing DIRECTOR_FAILED sentinel path.

        // Engagement fetch (24h cached inside smartScheduler).
        let engagement: CachedEngagement;
        try {
          engagement = await fetchInstagramEngagement(
            latestPropsRef.current.settings.apiKeys?.instagram?.accessToken,
            latestPropsRef.current.settings.apiKeys?.instagram?.igAccountId,
          );
        } catch {
          engagement = loadEngagementData();
        }
        const topHours = engagement.hours
          .sort((a: EngagementHour, b: EngagementHour) => b.weight - a.weight)
          .slice(0, 3)
          .map((h: EngagementHour) => `${h.hour}:00`);
        addLog(
          'engagement',
          '',
          'success',
          `Scheduler: ${engagement.source === 'instagram' ? 'IG insights' : 'research defaults'} — top hours: ${topHours.join(', ')}`,
        );

        let cycle = 0;

        // Functional-setState peek reads the latest committed value for
        // continuous-mode config without needing a ref.
        const peek = <T,>(setter: (updater: (prev: T) => T) => void): T => {
          let out: T;
          setter(prev => {
            out = prev;
            return prev;
          });
          return out!;
        };
        const readContinuous = () => peek<boolean>(setPipelineContinuous);
        const readInterval = () => peek<number>(setPipelineIntervalState);
        const readTargetDays = () => peek<number>(setPipelineTargetDaysState);
        const readDelay = () => peek<number>(setPipelineDelayState);
        const readIdeasPerCycle = () => peek<number>(setPipelineIdeasPerCycleState);

        do {
          cycle++;
          // V030-006: reset per cycle. Prior-cycle posts are already in
          // settings.scheduledPosts; keeping them here too would balloon
          // memory across a long-running continuous run.
          const accumulatedPosts: ScheduledPost[] = [];

          // AUTO-SCHEDULE-DEPTH-FIRST companion (2026-05-22, Issue 4):
          // pre-cycle fill check. Maurice reported auto-resume on app
          // restart kept generating even when the weekly post limit was
          // already met. The existing branch-decision logic at line ~720
          // only runs AFTER processIdea, so the first cycle of a freshly-
          // started run would always burn an idea + image-gen + schedule
          // before checking whether anything was needed. Now: at the
          // START of every cycle, compute fill status; if filled AND no
          // pending_approval items remain, skip directly to the sleep
          // path instead of generating. Same `interval`-minute sleep
          // shape as the post-processing branch — just hoisted earlier
          // so we don't waste a cycle on a week that's already done.
          //
          // V082-FIX-SETTINGS-HYDRATE: also wait for the IDB-loaded
          // settings to land before reading scheduledPosts. On a cold
          // mount, scheduledPosts starts as [] (defaultSettings), and
          // a pre-cycle check against [] would say "0/7 not full" and
          // generate even though the user actually has 7 posts. We
          // sleep in 250ms slices until settingsLoadedRef flips true,
          // bounded by a 5s ceiling so a hung IDB read can't pin the
          // run forever.
          if (!settingsLoadedRef.current) {
            addLog(
              'pipeline-preflight',
              '',
              'success',
              'Pre-cycle check: waiting for settings to hydrate from IDB before computing weekly fill…',
            );
            const preflightStart = Date.now();
            const preflightCeiling = 5000;
            const preflightSlice = 250;
            while (
              !settingsLoadedRef.current &&
              !runAbort.signal.aborted &&
              Date.now() - preflightStart < preflightCeiling
            ) {
              await wait(preflightSlice);
            }
            if (!settingsLoadedRef.current) {
              addLog(
                'pipeline-preflight',
                '',
                'error',
                'Settings still not loaded after 5s — proceeding with whatever is in memory (pre-cycle check may be inaccurate on a cold IDB read).',
              );
            } else {
              addLog(
                'pipeline-preflight',
                '',
                'success',
                `Settings hydrated in ${Date.now() - preflightStart}ms — running pre-cycle check.`,
              );
            }
          }
          {
            const settingsTargetDaysAtStart = readTargetDays();
            const targetPerDayAtStart =
              latestPropsRef.current.settings.pipelinePostsPerDay ?? 2;
            const allPostsAtStart =
              latestPropsRef.current.settings.scheduledPosts || [];
            const horizonDaysAtStart = Math.max(settingsTargetDaysAtStart, 14);
            const fillAtStart = computeWeekFillStatus(
              allPostsAtStart,
              horizonDaysAtStart,
              targetPerDayAtStart,
            );
            if (fillAtStart.filled && fillAtStart.pendingApprovalTotal === 0) {
              const intervalMinAtStart = readInterval();
              addLog(
                'pipeline-week-confirmed',
                '',
                'success',
                `Pre-cycle check: week already filled (${fillAtStart.scheduledTotal}/${fillAtStart.targetTotal} across ${horizonDaysAtStart}d, 0 pending) — sleeping ${intervalMinAtStart}m without generating`,
              );
              setPipelineProgress({
                current: 0,
                total: 0,
                currentStep: `Next week in ${intervalMinAtStart} min`,
                currentIdea: '',
              });
              const sleepMsAtStart = intervalMinAtStart * 60 * 1000;
              const sliceMsAtStart = 2000;
              for (
                let slept = 0;
                slept < sleepMsAtStart && !runAbort.signal.aborted;
                slept += sliceMsAtStart
              ) {
                await wait(Math.min(sliceMsAtStart, sleepMsAtStart - slept));
              }
              // Reset the one-shot prompt so the next horizon roll-over
              // can fire 'pipeline-week-confirmed' again.
              weekFilledPromptedThisRun = false;
              continue;
            }
          }

          let pendingIdeas = latestPropsRef.current.ideas.filter(i => i.status === 'idea');

          if (pendingIdeas.length === 0) {
            setPipelineProgress({
              current: 0,
              total: 0,
              currentStep: 'Auto-generating ideas...',
              currentIdea: '',
            });
            try {
              const generated = await autoGenerateIdeas(readIdeasPerCycle());
              for (const g of generated) {
                addIdea(g.concept, g.context || undefined);
              }
              const sharedTheme = generated[0]?.context?.startsWith('Theme: ')
                ? generated[0].context.replace(/^Theme:\s*/, '').split(' — ')[0]
                : '';
              addLog(
                'auto-generate',
                '',
                'success',
                sharedTheme
                  ? `Queue empty → generated ${generated.length} themed ideas via pi — theme: "${sharedTheme}"`
                  : `Queue empty → generated ${generated.length} ideas via pi`,
              );
              pendingIdeas = generated;
            } catch (e: unknown) {
              addLog(
                'auto-generate',
                '',
                'error',
                `Failed to auto-generate ideas: ${getErrorMessage(e)}`,
              );
              if (!readContinuous()) break;
              setPipelineProgress({
                current: 0,
                total: 0,
                currentStep: `Retry in ${readInterval()} min`,
                currentIdea: '',
              });
              await wait(readInterval() * 60 * 1000);
              continue;
            }
          }

          if (pendingIdeas.length === 0) {
            addLog(
              'pipeline-cycle',
              '',
              'success',
              `Cycle ${cycle} — no ideas available, stopping`,
            );
            break;
          }

          setPipelineQueue(pendingIdeas);
          addLog(
            'pipeline-cycle',
            '',
            'success',
            `Cycle ${cycle} — processing ${pendingIdeas.length} ideas`,
          );

          for (let i = 0; i < pendingIdeas.length; i++) {
            if (runAbort.signal.aborted) {
              addLog('pipeline-stop', '', 'success', 'Pipeline stopped by user');
              break;
            }

            const idea = pendingIdeas[i];
            setPipelineQueue(pendingIdeas.slice(i));

            // Fresh skip controller per idea; stale request from the previous
            // idea can't carry over.
            const skipAbort = new AbortController();
            setSkipCtrl(skipAbort);

            // V030-002: 10-min hard timeout so a stuck step can't pin the
            // daemon. When it fires we also abort the skip signal so
            // processIdea's checkpoint guards let the idea unwind cleanly.
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                skipAbort.abort();
                reject(new IdeaTimeoutError());
              }, PER_IDEA_TIMEOUT_MS);
            });

            // V050-001: only the resumed idea (by id) gets the resume
            // payload; consume the hint so the next idea runs from scratch.
            let resumeForThisIdea: ResumeContext | undefined;
            if (pendingResumeHint && pendingResumeHint.ideaId === idea.id) {
              resumeForThisIdea = { images: pendingResumeHint.images };
              pendingResumeHint = undefined;
            }

            try {
              await Promise.race([
                processIdea(
                  idea,
                  i,
                  pendingIdeas.length,
                  engagement,
                  accumulatedPosts,
                  skipAbort.signal,
                  writeCheckpointBase,
                  resumeForThisIdea,
                ),
                timeoutPromise,
              ]);
            } catch (e: unknown) {
              if (e instanceof IdeaTimeoutError) {
                addLog(
                  'pipeline-timeout',
                  idea.id,
                  'error',
                  `"${idea.concept}" exceeded ${PER_IDEA_TIMEOUT_MS / 60000}-min hard cap — continuing to next idea`,
                );
                updateIdeaStatus(idea.id, 'idea');
              } else if (e instanceof SkipIdeaSignal) {
                addLog(
                  'pipeline-skip',
                  idea.id,
                  'success',
                  `Skipped "${idea.concept}" by user request`,
                );
                updateIdeaStatus(idea.id, 'idea');
              } else {
                addLog(
                  'pipeline-error',
                  idea.id,
                  'error',
                  `Skipping idea due to error: ${getErrorMessage(e)}`,
                );
                updateIdeaStatus(idea.id, 'idea');
              }
            } finally {
              if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            }

            // PIPELINE-DAILY-CAP-CHECK (2026-05-22, Maurice's
            // /tmp/dev-pipeline-counter-bug.md): re-check fill status
            // after each idea's posts land in settings. If the horizon
            // is now filled and no pending approvals remain, break out
            // of the batch — don't burn the remaining ideas on a week
            // that's already done. Same logic as the pre-cycle check
            // from 08d76f7 but applied PER IDEA so an approval mid-batch
            // (which flips pending_approval → scheduled) is observed
            // immediately. latestPropsRef.current.settings is updated
            // via useEffect on every deps.settings change, so approvals
            // that happen DURING the batch loop reflect on the next
            // iteration's check — Issue 2 of the bug report.
            if (i < pendingIdeas.length - 1 && !runAbort.signal.aborted) {
              const targetDaysCheck = readTargetDays();
              const postsPerDayCheck =
                latestPropsRef.current.settings.pipelinePostsPerDay ?? 2;
              const horizonCheck = Math.max(targetDaysCheck, 14);
              const fillCheck = computeWeekFillStatus(
                [
                  ...(latestPropsRef.current.settings.scheduledPosts || []),
                  ...accumulatedPosts,
                ],
                horizonCheck,
                postsPerDayCheck,
              );
              if (
                fillCheck.filled
                && fillCheck.pendingApprovalTotal === 0
              ) {
                addLog(
                  'pipeline-cap-reached',
                  '',
                  'success',
                  `Daily cap met after idea ${i + 1}/${pendingIdeas.length} (${fillCheck.scheduledTotal}/${fillCheck.targetTotal} across ${horizonCheck}d, 0 pending) — stopping batch, ${pendingIdeas.length - i - 1} idea${pendingIdeas.length - i - 1 === 1 ? '' : 's'} stays queued`,
                );
                break;
              }
            }

            if (i < pendingIdeas.length - 1 && !runAbort.signal.aborted) {
              const d = readDelay();
              setPipelineProgress(prev =>
                prev ? { ...prev, currentStep: `Waiting ${d}s before next idea...` } : null,
              );
              await wait(d * 1000);
            }
          }

          if (runAbort.signal.aborted) break;

          if (readContinuous()) {
            // PIPELINE-CONT-V2: continuous mode is "fill week with
            // SCHEDULED (approved) posts → pause → repeat". The daemon
            // computes fill over the 2-week (14d) horizon counting only
            // `status==='scheduled'` toward `filled`. Three outcomes:
            //
            //   1. !filled — generate more, immediate next cycle.
            //   2. filled but pendingApprovalTotal > 0 — week looks
            //      "full" by raw post count but those posts haven't
            //      been approved yet, so they won't actually publish.
            //      Keep generating; the user's approval action will
            //      flip them to `scheduled` over time.
            //   3. filled AND pendingApprovalTotal === 0 — true fill,
            //      every horizon day has its scheduled-post target met
            //      with approved posts. Sleep `interval` before rolling
            //      into the next week.
            const settingsTargetDays = readTargetDays();
            const intervalMin = readInterval();
            const targetPerDay =
              latestPropsRef.current.settings.pipelinePostsPerDay ?? 2;
            const allPosts = [
              ...(latestPropsRef.current.settings.scheduledPosts || []),
              ...accumulatedPosts,
            ];
            const horizonDays = Math.max(settingsTargetDays, 14);
            const fill = computeWeekFillStatus(allPosts, horizonDays, targetPerDay);
            const futurePosts = fill.scheduledTotal;
            const targetTotal = fill.targetTotal;
            const pendingTotal = fill.pendingApprovalTotal;
            const emptyDays = fill.days.filter((d) => d.scheduledCount < d.target);
            const branch = pickContinuousBranch(fill);

            if (branch === 'continue-not-filled') {
              const gapSummary = emptyDays.length > 0
                ? ` (${emptyDays.length} day${emptyDays.length === 1 ? '' : 's'} under cap: ${emptyDays.map((d) => `${d.dayLabel} ${d.scheduledCount}/${d.target}`).join(', ')})`
                : '';
              const pendingSuffix = pendingTotal > 0
                ? ` + ${pendingTotal} pending approval`
                : '';
              addLog(
                'daemon',
                '',
                'success',
                `Schedule has ${futurePosts}/${targetTotal} scheduled${pendingSuffix} in next ${horizonDays}d${gapSummary} — running next cycle immediately`,
              );
              continue;
            }

            if (branch === 'continue-pending') {
              // PARTIAL fill — scheduled posts plus pending_approval cover
              // the slots, but pending_approval won't publish on its own.
              // Emit one info log per cycle and continue without sleeping.
              addLog(
                'pipeline-week-partial',
                '',
                'success',
                `Week has ${futurePosts}/${targetTotal} scheduled + ${pendingTotal} pending approval — continuing`,
              );
              continue;
            }

            // branch === 'sleep-confirmed' — every day's scheduled count
            // meets target and no posts are awaiting approval. Now we sleep.
            if (!weekFilledPromptedThisRun) {
              addLog(
                'pipeline-week-confirmed',
                '',
                'success',
                `Week confirmed filled: ${futurePosts}/${targetTotal} posts across ${horizonDays}d — all scheduled (pausing ${intervalMin}m before next week)`,
              );
              weekFilledPromptedThisRun = true;
            }
            addLog(
              'daemon',
              '',
              'success',
              `Schedule target met (${futurePosts}/${targetTotal}, 0 pending) — sleeping ${intervalMin}m before next week`,
            );

            setPipelineProgress({
              current: 0,
              total: 0,
              currentStep: `Next week in ${intervalMin} min`,
              currentIdea: '',
            });
            const sleepMs = intervalMin * 60 * 1000;
            const sliceMs = 2000;
            for (
              let slept = 0;
              slept < sleepMs && !runAbort.signal.aborted;
              slept += sliceMs
            ) {
              await wait(Math.min(sliceMs, sleepMs - slept));
            }
            // Reset the one-shot prompt so the next 2-week horizon can
            // log its own "filled" event.
            weekFilledPromptedThisRun = false;
          }
        } while (readContinuous() && !runAbort.signal.aborted);

        setPipelineQueue([]);
        setPipelineProgress(null);
        addLog(
          'pipeline-end',
          '',
          'success',
          `Pipeline finished after ${cycle} cycle${cycle === 1 ? '' : 's'}`,
        );
        // Clean exit — drop the checkpoint. Crash skips this, leaving the
        // last mid-step checkpoint intact for resume.
        void clearCheckpoint();
        // V030-003: log is only valuable across a crash. Clean completion
        // means the UI log state and the persisted copy can both drop.
        void clearPipelineLogStore();
      }),
    [
      pipelineDelay,
      pipelineContinuous,
      pipelineInterval,
      pipelineTargetDays,
      autoGenerateIdeas,
      addLog,
      addIdea,
      updateIdeaStatus,
    ],
  );

  // ── User-facing controls ─────────────────────────────────────────────────
  const togglePipeline = useCallback(() => setPipelineEnabled(p => !p), []);
  const setPipelineDelay = useCallback((d: number) => setPipelineDelayState(d), []);
  const toggleContinuous = useCallback(() => setPipelineContinuous(p => !p), []);
  const setPipelineInterval = useCallback(
    // PIPELINE-CONT-V2: minimum bumped 30 → 120 to match the user's stated
    // preference (120-min cycles). The default was already 120; this
    // closes the gap where the UI input could push it below the default.
    (m: number) => setPipelineIntervalState(Math.max(120, Math.min(1440, m))),
    [],
  );
  const setPipelineTargetDays = useCallback(
    (d: number) => setPipelineTargetDaysState(Math.max(1, Math.min(30, d))),
    [],
  );
  const setPipelineIdeasPerCycle = useCallback(
    (n: number) => setPipelineIdeasPerCycleState(Math.max(1, Math.min(10, n))),
    [],
  );
  const clearPipelineLog = useCallback(() => {
    setPipelineLog([]);
    void clearPipelineLogStore();
  }, []);

  // Stop/skip use functional setState peek to abort the current controller.
  const stopPipeline = useCallback(() => {
    setRunCtrl(c => {
      c?.abort();
      return c;
    });
    setSkipCtrl(c => {
      c?.abort();
      return c;
    });
  }, []);
  const skipCurrentIdea = useCallback(() => {
    setSkipCtrl(c => {
      c?.abort();
      return c;
    });
  }, []);

  const dismissResume = useCallback(() => {
    setPendingResume(null);
    void clearCheckpoint();
  }, []);

  // V030-004: reactive week-fill status for the UI meter. Recomputes on
  // any change to the scheduled post list, targetDays, or postsPerDay.
  const weekFillStatus: WeekFillStatus = useMemo(
    () =>
      computeWeekFillStatus(
        deps.settings.scheduledPosts,
        pipelineTargetDays,
        deps.settings.pipelinePostsPerDay ?? 2,
      ),
    [deps.settings.scheduledPosts, deps.settings.pipelinePostsPerDay, pipelineTargetDays],
  );

  return {
    // State
    pipelineEnabled,
    pipelineRunning,
    pipelineQueue,
    pipelineProgress,
    pipelineLog,
    pipelineDelay,
    pipelineContinuous,
    pipelineInterval,
    pipelineTargetDays,
    pipelineIdeasPerCycle,
    pendingResume,
    weekFillStatus,

    // Setters exposed for composer-built helpers (e.g. acceptResume)
    setPipelineDelayState,
    setPipelineContinuous,
    setPipelineIntervalState,
    setPipelineTargetDaysState,
    setPipelineIdeasPerCycleState,
    setPendingResume,
    setPipelineProgress,

    // Live readers (backed by consolidated latestPropsRef)
    getIdeas,
    getSettings,
    getImages,

    // Side channels for processor
    addLog,

    // User-facing controls
    togglePipeline,
    setPipelineDelay,
    toggleContinuous,
    setPipelineInterval,
    setPipelineTargetDays,
    setPipelineIdeasPerCycle,
    clearPipelineLog,
    stopPipeline,
    skipCurrentIdea,
    dismissResume,

    // Outer loop runner — composer wires processIdea through this
    runOuterLoop,

    // Debug / future use
    _runCtrl: runCtrl,
    _skipCtrl: skipCtrl,
  };
}
