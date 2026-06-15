'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { MashupProvider, useMashup } from './MashupContext';
import { ErrorBoundary } from './ErrorBoundary';
import { DesktopLoadingScreen } from './DesktopLoadingScreen';
import { PipelineResumePrompt } from './PipelineResumePrompt';
import { OnboardingWizard } from './onboarding/OnboardingWizard';
import { SetupUnfinishedPill } from './onboarding/SetupUnfinishedPill';
import { ShieldAlert, Cpu, LayoutDashboard } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { CreditBudgetBanner } from './CreditBudgetBanner';
import { MinimaxQuotaBanner } from './MinimaxQuotaBanner';
import { resolveAllowance } from '@/lib/minimax-quota';
import { useSettings } from '@/hooks/useSettings';

const Sidebar = dynamic(
  () => import('./Sidebar').then((m) => m.Sidebar),
  { ssr: false },
);

const MainContent = dynamic(
  () => import('./MainContent').then((m) => m.MainContent),
  { ssr: false },
);

// FEAT-MMX-MUSIC-UI: floating Music + Video action group. Hides itself
// when the mmx CLI is unavailable on the server.
const MmxStudioPanel = dynamic(
  () => import('./mmx/MmxStudioPanel').then((m) => m.MmxStudioPanel),
  { ssr: false },
);

// AGENTIC-CORE / PHASE 1: the new character-faithful agentic chat console,
// wired to the tool-loop agent (the ToolLoopAgent / Director loop). Mounted
// ADDITIVELY behind an "Agent" view toggle below — the legacy Sidebar +
// MainContent stay reachable via the "Studio" toggle. ssr:false because the
// console reads client-only registries (connectors / skills / settings).
const AgentConsole = dynamic(
  () => import('./agent/AgentConsole').then((m) => m.AgentConsole),
  { ssr: false },
);

/**
 * AGENTIC-CORE / PHASE 1: which primary surface the studio shows. 'studio' is
 * the existing Sidebar + MainContent (unchanged); 'agent' is the new
 * Cyberforge agent console. Default stays 'studio' so nothing about the
 * existing first-run experience changes.
 */
type PrimarySurface = 'studio' | 'agent';

/** V050-DES-002 — first-run + pill state machine.
 *  Reads localStorage flags only (schema field is PROP). */
type OnboardingState =
  | { kind: 'loading' }
  | { kind: 'show-wizard'; initialStep: 1 | 2 | 3 }
  | { kind: 'show-pill'; lastCompletedStep: number }
  | { kind: 'hidden' };

function useOnboardingState(): [OnboardingState, (s: OnboardingState) => void] {
  const [state, setState] = useState<OnboardingState>({ kind: 'loading' });

  // V105.1-REACT-19: setState calls are deferred via queueMicrotask
  // (project convention) so the effect body only reads localStorage,
  // not local state in the body itself.
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const completed = localStorage.getItem('mashup.onboarded') === '1';
        if (completed) { setState({ kind: 'hidden' }); return; }

        const dismissed = localStorage.getItem('mashup.onboardingDismissedAt');
        if (dismissed) { setState({ kind: 'hidden' }); return; }

        const skippedAt = localStorage.getItem('mashup.onboardingSkippedAt');
        const progressRaw = localStorage.getItem('mashup.onboardingProgress');
        const progress = progressRaw ? JSON.parse(progressRaw) as { step?: 1 | 2 | 3; lastCompleted?: number } : null;

        if (skippedAt) {
          setState({ kind: 'show-pill', lastCompletedStep: progress?.lastCompleted ?? 0 });
        } else {
          setState({ kind: 'show-wizard', initialStep: progress?.step ?? 1 });
        }
      } catch {
        setState({ kind: 'show-wizard', initialStep: 1 });
      }
    });
  }, []);

  return [state, setState];
}

// FEAT-TRAY-AUTOSTART (2026-05-20): on first ever launch inside the
// Tauri desktop shell, enable OS-level autostart so the user gets the
// "background-poster" behavior by default. Subsequent launches respect
// whatever the user set in Settings → Auto-Start. The localStorage flag
// is the one-shot gate — never re-runs once flipped.
function useFirstLaunchAutostart() {
  useEffect(() => {
    const isTauri = typeof window !== 'undefined'
      && typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
    if (!isTauri) return;

    const FLAG = 'mashup.autostartFirstRunDone';
    try {
      if (localStorage.getItem(FLAG) === '1') return;
    } catch {
      return; // private mode → don't risk re-enabling on every launch
    }

    void (async () => {
      try {
        const mod = await import('@tauri-apps/plugin-autostart');
        const already = await mod.isEnabled();
        if (!already) await mod.enable();
        localStorage.setItem(FLAG, '1');
      } catch {
        // Silent — Settings → Auto-Start is the manual fallback. We
        // intentionally don't set the flag on failure so a retry can
        // happen on next launch.
      }
    })();
  }, []);
}

function MashupApp() {
  const { isLoaded } = useMashup();
  const { isAuthenticated } = useAuth();
  const [onboarding, setOnboarding] = useOnboardingState();
  // AGENTIC-CORE / PHASE 1: primary-surface toggle. Defaults to 'studio' so
  // the existing UI is exactly what loads; the operator opts into the new
  // agent console via the floating switcher.
  const [surface, setSurface] = useState<PrimarySurface>('studio');
  useFirstLaunchAutostart();

  // V1.2.3: gate ONLY on auth. The 4 hook-level isLoaded flags
  // (isSettingsLoaded, isImagesLoaded, isCollectionsLoaded,
  // isIdeasLoaded) are now lazy in v1.2.1+v1.2.2 and may stay
  // false for a few seconds while the Tauri plugin-store loads the
  // userData file. We don't want the studio splash to sit during
  // that window — render the studio immediately with default/empty
  // state and let the hooks hydrate in the background. The
  // background hydration triggers MashupProvider re-renders that
  // re-render <MainContent> with the real data.
  //
  // The gate `isAuthenticated === null` is the only thing that
  // should block the splash. `isAuthenticated === false` redirects
  // to login (handled below). `!isLoaded` no longer blocks.
  if (isAuthenticated === null) {
    return <DesktopLoadingScreen />;
  }

  if (isAuthenticated === false) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#050505]">
        <div className="flex flex-col items-center gap-5 text-center">
          <div className="w-16 h-16 rounded-2xl bg-[#ff7a18]/10 border border-[#ff7a18]/30 flex items-center justify-center">
            <ShieldAlert className="w-8 h-8 text-[#ff7a18]" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white mb-1">Access Restricted</h2>
            <p className="text-zinc-500 text-sm">Please log in to access AIart4never Studio.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950">
      {/* V1.0.7-PROMPT-ENG-D: low-credit + cap-reached banner. The
          banner is self-gating (returns null when the cap isn't set
          or usage is under 80%) so this is a safe unconditional
          mount. Sits above the Sidebar so it never gets covered by
          the floating panels. */}
      <StudioCreditStrip />

      {/* AGENTIC-CORE / PHASE 1: primary-surface switcher. Floating, top-
          centre, above both surfaces. Lets the operator flip between the
          existing Studio (Sidebar + MainContent) and the new agentic
          Cyberforge console without removing either. */}
      <SurfaceSwitcher surface={surface} onChange={setSurface} />

      {surface === 'agent' ? (
        <ErrorBoundary section="AgentConsole">
          <AgentConsole />
        </ErrorBoundary>
      ) : (
        <>
          <ErrorBoundary section="Sidebar">
            <Sidebar />
          </ErrorBoundary>
          <ErrorBoundary section="MainContent">
            <MainContent />
          </ErrorBoundary>
        </>
      )}
      <ErrorBoundary section="MmxStudioPanel">
        <MmxStudioPanel />
      </ErrorBoundary>
      <PipelineResumePrompt />

      {onboarding.kind === 'show-wizard' && (
        <OnboardingWizard
          initialStep={onboarding.initialStep}
          onComplete={() => setOnboarding({ kind: 'hidden' })}
          onSkip={(lastCompletedStep) => setOnboarding({ kind: 'show-pill', lastCompletedStep })}
        />
      )}

      {onboarding.kind === 'show-pill' && (
        <SetupUnfinishedPill
          lastCompletedStep={onboarding.lastCompletedStep}
          onResume={() => {
            try {
              const raw = localStorage.getItem('mashup.onboardingProgress');
              const progress = raw ? JSON.parse(raw) as { step?: 1 | 2 | 3 } : null;
              const initialStep = (progress?.step ?? Math.min(3, onboarding.lastCompletedStep + 1)) as 1 | 2 | 3;
              localStorage.removeItem('mashup.onboardingSkippedAt');
              setOnboarding({ kind: 'show-wizard', initialStep });
            } catch {
              setOnboarding({ kind: 'show-wizard', initialStep: 1 });
            }
          }}
          onDismissForever={() => {
            try { localStorage.setItem('mashup.onboardingDismissedAt', String(Date.now())); } catch { /* silent */ }
            setOnboarding({ kind: 'hidden' });
          }}
        />
      )}
    </div>
  );
}

export function MashupStudio() {
  return (
    <ErrorBoundary section="App" fullScreen>
      <MashupProvider>
        <MashupApp />
      </MashupProvider>
    </ErrorBoundary>
  );
}

/**
 * V1.0.7-PROMPT-ENG-D: thin strip at the top of the studio that
 * surfaces the credit-budget banner. The strip is always rendered;
 * the banner inside it self-gates on cap/usage, so the strip is
 * effectively a no-op when no cap is set or usage is healthy.
 *
 * Lives outside the Sidebar/MainContent so the floating MmxStudioPanel
 * never covers it. Sits at the top of the flex column with the rest
 * of the studio below — no z-index gymnastics required.
 */
/**
 * AGENTIC-CORE / PHASE 1: floating switcher between the existing Studio
 * surface and the new agentic Cyberforge console. Centre-top, pointer-events
 * isolated so it never blocks the surfaces behind it. Orange = active (the
 * AIART4NEVER primary); ashen = inactive.
 */
function SurfaceSwitcher({
  surface,
  onChange,
}: {
  surface: PrimarySurface;
  onChange: (s: PrimarySurface) => void;
}) {
  const items: Array<{ id: PrimarySurface; label: string; Icon: typeof Cpu }> = [
    { id: 'studio', label: 'Studio', Icon: LayoutDashboard },
    { id: 'agent', label: 'Agent', Icon: Cpu },
  ];
  return (
    <div className="absolute top-2.5 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
      <div
        role="tablist"
        aria-label="Primary surface"
        className="pointer-events-auto flex items-center gap-1 p-1 rounded-xl bg-[#0a0b0d]/90 backdrop-blur-xl border border-[#ff7a18]/25 shadow-xl"
      >
        {items.map(({ id, label, Icon }) => {
          const active = surface === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
                active
                  ? 'bg-[#ff7a18]/15 text-[#ff9d4d] border border-[#ff7a18]/40'
                  : 'text-[#8a97a6] hover:text-zinc-200 border border-transparent'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StudioCreditStrip() {
  const { settings } = useSettings();
  // Bumping the tick after every successful generation is the
  // hook's responsibility (out of scope here). The banner re-reads
  // the persistence on mount + when refreshTick changes.
  // 4NE-21 / Story 1.5: resolve the monthly MiniMax token allowance from
  // the tier (+ optional custom cap). The banner self-gates below the warn
  // threshold, so an unconditional mount is safe.
  const minimaxAllowance = resolveAllowance(settings.minimaxTier, settings.minimaxCustomTokenCap);
  return (
    <div className="absolute top-0 left-0 right-0 z-30 p-3 pointer-events-none">
      <div className="pointer-events-auto max-w-3xl mx-auto space-y-2">
        <CreditBudgetBanner cap={settings.higgsfieldMonthlyCreditCap} />
        <MinimaxQuotaBanner allowance={minimaxAllowance} />
      </div>
    </div>
  );
}
