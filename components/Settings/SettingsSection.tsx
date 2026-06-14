'use client';

/**
 * V082: SettingsSection — single source of truth for the section
 * divider + heading + icon + sub-text pattern used throughout the
 * Settings modal. Each tab renders a stack of these; using a helper
 * keeps the spacing, gold accent, and icon-row consistent across
 * Watermark, Default Video Settings, AI System Prompt, and the
 * AI Engine active-model card. Replaces the ad-hoc
 * `<div className="mt-8 pt-6 border-t border-zinc-800"><h4
 * className="text-lg font-medium text-white mb-4">…</h4></div>`
 * pattern that had drifted across four places with different
 * paddings / icon usage.
 *
 * M3.4-P4-B2: extracted from `components/SettingsModal.tsx` so the
 * Settings sub-components (`WatermarkSettings`, `SystemPromptEditor`)
 * can wrap their own content without re-importing SettingsModal or
 * duplicating the icon-row + heading layout.
 */
export type SettingsSectionTone = 'gold' | 'cyan' | 'emerald';

export interface SettingsSectionProps {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  tone?: SettingsSectionTone;
}

const TONE_TEXT: Record<SettingsSectionTone, string> = {
  gold: 'text-[#c5a062]',
  cyan: 'text-[#00e6ff]',
  emerald: 'text-emerald-400',
};

const TONE_BORDER: Record<SettingsSectionTone, string> = {
  gold: 'border-[#c5a062]/20',
  cyan: 'border-[#00e6ff]/20',
  emerald: 'border-emerald-500/20',
};

export function SettingsSection({
  icon: Icon,
  title,
  subtitle,
  children,
  tone = 'gold',
}: SettingsSectionProps) {
  const toneText = TONE_TEXT[tone];
  const toneBorder = TONE_BORDER[tone];
  return (
    <section
      className={`mt-8 pt-6 border-t ${toneBorder} first:mt-0 first:pt-0 first:border-t-0`}
    >
      <header className="mb-4 flex items-start gap-3">
        <div
          className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${toneBorder} bg-black/40 ${toneText}`}
        >
          <Icon className="h-4 w-4" aria-hidden={true} />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-base font-semibold text-white leading-tight">{title}</h4>
          {subtitle && (
            <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{subtitle}</p>
          )}
        </div>
      </header>
      {children}
    </section>
  );
}
