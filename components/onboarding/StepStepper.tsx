'use client';

interface StepStepperProps {
  current: 1 | 2 | 3;
  total?: number;
}

/**
 * 3-dot stepper used by the OnboardingWizard header.
 * Past steps emerald-filled, current gold-ringed, future zinc-empty.
 * Connectors mirror the same emerald/zinc divide.
 */
export function StepStepper({ current, total = 3 }: StepStepperProps) {
  const steps = Array.from({ length: total }, (_, i) => i + 1);

  return (
    <div className="flex items-center justify-between gap-3">
      <div
        role="progressbar"
        aria-valuenow={current}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-label={`Onboarding step ${current} of ${total}`}
        className="flex items-center flex-1"
      >
        {steps.map((step, idx) => {
          const isPast = step < current;
          const isCurrent = step === current;
          const isLast = idx === steps.length - 1;

          return (
            <div key={step} className="flex items-center flex-1 last:flex-initial">
              <div
                className={`w-3 h-3 rounded-full shrink-0 transition-colors ${
                  isPast
                    ? 'bg-emerald-500'
                    : isCurrent
                      ? 'bg-[#c5a062] ring-2 ring-[#c5a062]/40'
                      : 'bg-zinc-700'
                }`}
              />
              {!isLast && (
                <div
                  className={`flex-1 h-px mx-2 transition-colors ${
                    isPast ? 'bg-emerald-500' : 'bg-zinc-800'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
      <span className="text-xs text-zinc-500 shrink-0">
        Step {current} of {total}
      </span>
    </div>
  );
}
