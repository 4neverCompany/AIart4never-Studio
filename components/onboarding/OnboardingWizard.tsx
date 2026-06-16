'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { useMashup } from '../MashupContext';
import { StepStepper } from './StepStepper';
import { Step1Platform, type OnboardingPlatform } from './steps/Step1Platform';
import { Step2Niche } from './steps/Step2Niche';

interface OnboardingWizardProps {
  /** Step (1–2) to open at; defaults to 1 or to last incomplete from progress. */
  initialStep?: 1 | 2;
  onComplete: () => void;
  onSkip: (lastCompletedStep: number) => void;
}

/**
 * V050-DES-002 — first-run onboarding wizard. Self-contained focus-trapped
 * modal. Real schema flag (`UserSettings.onboardingCompletedAt`) is
 * flagged complex (PROP); we use localStorage `mashup.onboarded` until
 * the schema field lands. The MashupStudio root mounts/unmounts this
 * based on the flag.
 */
export function OnboardingWizard({ initialStep = 1, onComplete, onSkip }: OnboardingWizardProps) {
  const { settings, updateSettings } = useMashup();
  const [step, setStep] = useState<1 | 2>(initialStep);

  // Step 1 state — selected platform + saved-credentials flag
  const [platform, setPlatform] = useState<OnboardingPlatform | null>(null);
  const [credsSaved, setCredsSaved] = useState(false);
  const [step1Skipped, setStep1Skipped] = useState(false);

  // Step 2 state — universes + genres (mirror existing settings fields)
  const [universes, setUniverses] = useState<string[]>(settings.agentNiches || []);
  const [genres, setGenres] = useState<string[]>(settings.agentGenres || []);

  // Skip-confirmation overlay
  const [skipConfirming, setSkipConfirming] = useState(false);

  // Track wizard progress in localStorage so a hard refresh resumes
  // at the last-completed step instead of resetting to 1.
  useEffect(() => {
    try {
      const lastCompleted = step === 1 ? 0 : 1;
      localStorage.setItem(
        'mashup.onboardingProgress',
        JSON.stringify({ step, lastCompleted, platformPicked: !!platform, nichesChosen: universes.length > 0 }),
      );
    } catch { /* quota — silent */ }
  }, [step, platform, universes]);

  // Focus trap — keep Tab cycling inside the dialog. Initial focus on
  // the first interactive element of the body via autoFocus on the
  // step 1 tile (or skip header on later steps).
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (skipConfirming) setSkipConfirming(false);
        else setSkipConfirming(true);
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [skipConfirming]);

  function canAdvanceFromStep1(): boolean {
    return credsSaved || step1Skipped;
  }

  function canAdvanceFromStep2(): boolean {
    return universes.length >= 1 && genres.length >= 1;
  }

  function handleNext() {
    if (step === 1 && canAdvanceFromStep1()) setStep(2);
    else if (step === 2 && canAdvanceFromStep2()) {
      // Persist niches into settings, then complete: write flag, close,
      // and hand back to the host (which routes into the app).
      updateSettings({ agentNiches: universes, agentGenres: genres });
      try { localStorage.setItem('mashup.onboarded', '1'); } catch { /* silent */ }
      try { localStorage.removeItem('mashup.onboardingProgress'); } catch { /* silent */ }
      onComplete();
    }
  }

  function handleBack() {
    if (step === 2) setStep(1);
  }

  function confirmSkip() {
    try {
      const lastCompleted = step === 1 ? 0 : 1;
      localStorage.setItem('mashup.onboardingSkippedAt', String(Date.now()));
      localStorage.setItem('mashup.onboardingProgress', JSON.stringify({ step, lastCompleted }));
    } catch { /* silent */ }
    onSkip(step === 1 ? 0 : 1);
  }

  const nextLabel = step === 2 ? 'Finish setup' : 'Next';

  const nextDisabled =
    (step === 1 && !canAdvanceFromStep1()) ||
    (step === 2 && !canAdvanceFromStep2());

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
    >
      <div
        ref={dialogRef}
        // V080-DES-001: drop the unconditional min-h on small viewports —
        // a 540px floor on a 360px-tall phone pushes the footer (Continue
        // button) below the visible area. The body's flex-1 + overflow-y-auto
        // already handles content growth; we just need to let the dialog
        // size to the viewport on short screens.
        className="max-w-[640px] w-[calc(100vw-2rem)] sm:min-h-[540px] max-h-[calc(100vh-2rem)] bg-zinc-950/95 backdrop-blur-xl border border-[#ff7a18]/30 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between border-b border-zinc-900 flex-shrink-0">
          <span id="onboarding-title" className="text-sm font-bold tracking-wide text-[#ff7a18]">AIART4NEVER STUDIO</span>
          <button
            type="button"
            onClick={() => setSkipConfirming(true)}
            className="text-xs text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1"
          >
            Skip for now <X className="w-3 h-3" />
          </button>
        </div>

        {/* Stepper */}
        <div className="px-6 py-4 border-b border-zinc-900 flex-shrink-0">
          <StepStepper current={step} total={2} />
        </div>

        {/* Body */}
        <div className="flex-1 px-6 py-6 overflow-y-auto">
          {step === 1 && (
            <Step1Platform
              selected={platform}
              onSelect={setPlatform}
              saved={credsSaved}
              onSaved={setCredsSaved}
              onSkip={() => { setStep1Skipped(true); setStep(2); }}
            />
          )}
          {step === 2 && (
            <Step2Niche
              universes={universes}
              genres={genres}
              onChangeUniverses={setUniverses}
              onChangeGenres={setGenres}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-900 flex items-center justify-between flex-shrink-0">
          <button
            type="button"
            onClick={handleBack}
            disabled={step === 1}
            className="text-xs text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            <ArrowLeft className="w-3 h-3" /> Back
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={nextDisabled}
            className="px-4 py-2 text-sm bg-[#ff7a18] hover:bg-[#ff9d4d] disabled:opacity-40 disabled:cursor-not-allowed text-zinc-950 font-medium rounded-lg inline-flex items-center gap-2 transition-colors"
          >
            {nextLabel} <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>

      {skipConfirming && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4">
          <div className="bg-zinc-950 border border-[#ff7a18]/30 rounded-xl p-5 max-w-sm space-y-4">
            <h4 className="text-sm font-bold text-white">Skip setup?</h4>
            <p className="text-xs text-zinc-400">You can finish from the Settings menu anytime.</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setSkipConfirming(false)}
                className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg"
              >
                Keep going
              </button>
              <button
                onClick={confirmSkip}
                className="px-3 py-1.5 text-xs bg-[#ff7a18] hover:bg-[#ff9d4d] text-zinc-950 font-medium rounded-lg"
              >
                Yes, skip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

