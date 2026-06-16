'use client';

/**
 * AGENTIC-CORE / PHASE 2 — the Cyberforge command bar.
 *
 * The studio's top-spanning shell, mounted by {@link MashupStudio}. It replaces
 * the old floating surface-switcher with a real topbar. Left → right:
 *   - the AIart4never wordmark (the "AI" in AIART4NEVER orange);
 *   - the segmented Chat↔Gallery toggle. 'agent' surface = Chat (the
 *     AgentConsole + its rail); 'studio' surface = Gallery (MainContent). This
 *     IS the primary-surface switch — the inner Gallery/Captioning/Post-Ready
 *     tabs stay where they are inside MainContent;
 *   - the active-character switcher (reads `settings.activeCharacterId`, writes
 *     via `updateSettings` — the exact field the canon system block + the
 *     director loop read, so changing it re-shapes every prompt/caption/plan);
 *   - the connector status dots (Higgsfield + Composio, cyan = connected, read
 *     from the REAL connector health sweep);
 *   - the budget readout (mono / orange, from the real credit-usage record).
 *
 * Extracted from MashupStudio into its own module so the toggle + switcher +
 * dots are unit-testable in isolation (see tests/components/StudioTopbar.test).
 */

import dynamic from 'next/dynamic';
import { MessageSquare, Images, ChevronDown } from 'lucide-react';
import { useSettings } from '@/hooks/useSettings';
import { listCharacters, type CharacterId } from '@/lib/canon';
import { StudioBudgetReadout } from './StudioBudgetReadout';

// PHASE 2: lazy-load the connector dots. `useConnectors` drags the
// `@/lib/connectors` + MCP-SDK machinery, which must stay OUT of the
// always-mounted `/studio` first-load bundle (the AgentConsole already
// lazy-loads the same dependency). A 2-dot placeholder holds the layout while
// it hydrates so the topbar never reflows.
const ConnectorDots = dynamic(
  () => import('./ConnectorDots').then((m) => m.ConnectorDots),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center gap-2" aria-hidden>
        <span className="conn-dot" />
        <span className="conn-dot" />
      </div>
    ),
  },
);

/** Which primary surface the studio shows. 'studio' = Gallery (MainContent);
 *  'agent' = Chat (the agentic Cyberforge console + rail). */
export type PrimarySurface = 'studio' | 'agent';

export function StudioTopbar({
  surface,
  onChange,
}: {
  surface: PrimarySurface;
  onChange: (s: PrimarySurface) => void;
}) {
  const items: Array<{
    id: PrimarySurface;
    label: string;
    Icon: typeof MessageSquare;
  }> = [
    { id: 'agent', label: 'Chat', Icon: MessageSquare },
    { id: 'studio', label: 'Gallery', Icon: Images },
  ];
  return (
    <header className="studio-topbar z-40">
      {/* Wordmark */}
      <div
        className="flex items-center gap-1.5 select-none"
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        <span className="text-sm font-extrabold tracking-tight">
          <span className="text-[#ff7a18]">AI</span>
          <span className="text-[#e8edf2]">art4never</span>
        </span>
      </div>

      {/* Segmented Chat↔Gallery toggle */}
      <div
        role="tablist"
        aria-label="Primary surface"
        data-testid="surface-toggle"
        className="seg-track ml-1"
      >
        {items.map(({ id, label, Icon }) => {
          const active = surface === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`surface-tab-${label.toLowerCase()}`}
              onClick={() => onChange(id)}
              className={`seg-item ${active ? 'seg-item-active' : ''}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Right cluster: character switcher + connector dots + budget */}
      <div className="ml-auto flex items-center gap-3">
        <CharacterSwitcher />
        <ConnectorDots />
        <StudioBudgetReadout />
      </div>
    </header>
  );
}

/**
 * The active-character switcher. Reads the persisted `activeCharacterId` and
 * writes the operator's choice straight back via `updateSettings`.
 */
export function CharacterSwitcher() {
  const { settings, updateSettings } = useSettings();
  const characters = listCharacters();
  const activeId = (settings.activeCharacterId ?? 'kael') as CharacterId;
  const active = characters.find((c) => c.id === activeId) ?? characters[0];

  return (
    <label className="relative flex items-center" data-testid="character-switcher">
      <span className="sr-only">Active character</span>
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-[#ff7a18] mr-2 shrink-0"
        aria-hidden
      />
      <select
        value={activeId}
        onChange={(e) =>
          updateSettings({ activeCharacterId: e.target.value as CharacterId })
        }
        aria-label="Active character"
        className="appearance-none bg-transparent pr-5 text-xs font-semibold text-[#e8edf2] hover:text-white focus:outline-none cursor-pointer max-w-[150px] truncate"
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        {characters.map((c) => (
          <option key={c.id} value={c.id} className="bg-[#0a0b0e] text-[#e8edf2]">
            {c.name}
          </option>
        ))}
      </select>
      <ChevronDown
        className="absolute right-0 w-3 h-3 text-[#8a97a6] pointer-events-none"
        aria-hidden
      />
      <span className="sr-only" data-testid="active-character-name">
        {active?.name}
      </span>
    </label>
  );
}

