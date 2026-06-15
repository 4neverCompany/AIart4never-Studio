'use client';

/**
 * 4NE-12 + 4NE-27 — the in-app "Customize" panel.
 *
 * Two sections, both built ON TOP of the existing service layers (the UI only
 * calls + renders; all heavy lifting stays in `@/lib/connectors`, `@/lib/mcp`,
 * `@/lib/approval`):
 *
 *   • Connectors (4NE-12) — list configured MCP connectors with a live health
 *     status pill, an enabled toggle (`setEnabled`), a Test button
 *     (`checkConnectorHealth`), a confirm-gated Remove, and the FR-22
 *     operator-gated Add-connector flow (`proposeConnector` → render the
 *     REDACTED config → operator Confirm mints a `connector-activate` token →
 *     `confirmAndInstall`).
 *
 *   • Skills (4NE-27) — list least-privilege tool bundles and add/remove them
 *     via the `@/lib/connectors` skills API (`validateSkill` / `saveSkill` /
 *     `removeSkill`).
 *
 * Slots into the Settings modal as the "Customize" tab, styled to match the
 * sibling Settings sections (SettingsSection wrapper, Ashen-Cyberforge tokens:
 * orange `#ff7a18` for primary/active, cyan `#00e6ff` for secondary/links).
 */

import { Loader2, Plug, Boxes } from 'lucide-react';
import { SettingsSection } from './SettingsSection';
import { useConnectors } from '@/hooks/useConnectors';
import { useSkills } from '@/hooks/useSkills';
import { ConnectorRow } from './customize/ConnectorRow';
import { AddConnectorForm } from './customize/AddConnectorForm';
import { SkillsSection } from './customize/SkillsSection';

export function CustomizePanel() {
  const connectors = useConnectors();
  const skills = useSkills();

  return (
    <div className="space-y-6">
      {/* ── Connectors (4NE-12) ─────────────────────────────────────────── */}
      <SettingsSection
        icon={Plug}
        title="Connectors"
        subtitle="Manage the MCP servers this agent can reach. Install only connectors you paste here yourself — confirming an install is the trust grant."
        tone="gold"
      >
        <div className="space-y-3">
          {connectors.loading ? (
            <div className="flex items-center gap-2 py-3 text-zinc-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-xs">Loading connectors…</span>
            </div>
          ) : connectors.servers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 py-4 text-center">
              <p className="text-[11px] italic text-zinc-500">
                No connectors configured yet. Add one below.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {connectors.servers.map((server) => (
                <ConnectorRow
                  key={server.id}
                  server={server}
                  health={connectors.health[server.id]}
                  onToggle={connectors.toggle}
                  onTest={connectors.test}
                  onRemove={connectors.remove}
                />
              ))}
            </div>
          )}

          <AddConnectorForm propose={connectors.propose} install={connectors.install} />
        </div>
      </SettingsSection>

      {/* ── Skills (4NE-27) ─────────────────────────────────────────────── */}
      <SettingsSection
        icon={Boxes}
        title="Skills"
        subtitle="Least-privilege tool bundles. A skill grants the agent only the named subset of one connector's tools."
        tone="cyan"
      >
        <SkillsSection
          skills={skills.skills}
          loading={skills.loading}
          validate={skills.validate}
          save={skills.save}
          remove={skills.remove}
          servers={connectors.servers}
        />
      </SettingsSection>
    </div>
  );
}
