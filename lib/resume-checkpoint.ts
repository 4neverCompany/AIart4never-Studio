// FEAT-006 / SHOULDFIX-001 / V030-001: pure side-effect driver for the
// resume-accept flow. Extracted from usePipeline.acceptResume so the
// interaction (setters + idea-status flip + startPipeline call) is
// testable without renderHook / jsdom.
//
// V030-001: the daemon no longer keeps per-field refs — the outer loop
// reads live values via functional setState peek. This helper is now
// ref-free: it takes setters + getIdeas() only.
//
// V050-001: credit-preserving resume. acceptResume now looks up the
// images stored in the checkpoint (saved gallery, by id) and forwards
// them to startPipeline as a resume hint. The daemon hands the hint
// to processIdea on the matching idea, which skips trending/expand/
// generate and resumes at captioning — no Leonardo credits are spent
// re-generating images that already exist.

import type { PipelineCheckpoint } from './pipeline-checkpoint';
import type { Idea, GeneratedImage } from '../types/mashup';

/** V050-001: resume payload forwarded to startPipeline. Mirrors the daemon's PipelineResumeHint. */
export interface ResumeStartHint {
  ideaId: string;
  images: GeneratedImage[];
}

export interface ApplyResumeDeps {
  /** State setters for the four pipeline settings we snapshot. */
  setPipelineDelayState: (v: number) => void;
  setPipelineContinuous: (v: boolean) => void;
  setPipelineIntervalState: (v: number) => void;
  setPipelineTargetDaysState: (v: number) => void;
  /** Live reader over the ideas list; the in-flight idea is looked up by id. */
  getIdeas: () => Idea[];
  /**
   * V050-001: live reader over the saved gallery. Used to look up the
   * pre-generated images by checkpoint.imageIds so the resumed run can
   * skip Leonardo generation. Optional — when omitted, resume falls back
   * to the pre-V050 behavior of restarting from scratch.
   */
  getSavedImages?: () => GeneratedImage[];
  /** Flip status back to 'idea' so startPipeline re-runs the in-flight idea. */
  updateIdeaStatus: (id: string, status: 'idea' | 'in-work' | 'done') => void;
  /** Clears the resume prompt. */
  setPendingResume: (v: null) => void;
  /** Kicks the pipeline run. Optionally accepts a credit-preserving resume hint. */
  startPipeline: (resumeHint?: ResumeStartHint) => void | Promise<void>;
}

/**
 * Apply a resume checkpoint: push snapshot settings through setters,
 * flip the in-flight idea back to 'idea' if still 'in-work', clear the
 * prompt, call startPipeline with a resume hint when pre-generated
 * images are available.
 *
 * No-ops if cp is null — matches the early-return in the React wrapper.
 */
export function applyResumeCheckpoint(
  cp: PipelineCheckpoint | null,
  deps: ApplyResumeDeps,
): void {
  if (!cp) return;

  deps.setPipelineDelayState(cp.settings.delay);
  deps.setPipelineContinuous(cp.settings.continuous);
  deps.setPipelineIntervalState(cp.settings.interval);
  deps.setPipelineTargetDaysState(cp.settings.targetDays);

  const idea = deps.getIdeas().find(i => i.id === cp.ideaId);
  if (idea && idea.status === 'in-work') deps.updateIdeaStatus(cp.ideaId, 'idea');

  // V050-001: if the checkpoint recorded image ids and we can look them up
  // in the saved gallery, hand them to startPipeline so the resumed run
  // skips image generation. Missing images (deleted/cleared) silently fall
  // through to a full restart of that idea — credits will be spent, but
  // the user opted in by clicking "Resume" so this is acceptable.
  let resumeHint: ResumeStartHint | undefined;
  if (cp.imageIds.length > 0 && deps.getSavedImages) {
    const saved = deps.getSavedImages();
    const byId = new Map(saved.map(img => [img.id, img]));
    const matched = cp.imageIds.map(id => byId.get(id)).filter((i): i is GeneratedImage => !!i);
    if (matched.length > 0) {
      resumeHint = { ideaId: cp.ideaId, images: matched };
    }
  }

  deps.setPendingResume(null);
  void deps.startPipeline(resumeHint);
}
