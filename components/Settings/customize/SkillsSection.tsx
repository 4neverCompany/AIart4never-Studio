'use client';

/**
 * 4NE-27 — Skills manager section.
 *
 * Lists persisted skills (name, bound connector, tool count) and an add-form
 * (name + connectorId + comma-separated tool names). The form runs the lib's
 * `validateSkill` before calling `save` so a malformed bundle never reaches
 * storage. Remove requires an inline confirm. All persistence is the
 * `@/lib/connectors` skills API via the `useSkills` hook (passed in as props).
 *
 * A Skill is least-privilege: it names the SUBSET of one connector's tools the
 * agent may call. We surface the bound connector by name when it is still in
 * the registry, falling back to the raw id when it's gone (a stale skill).
 */

import { useCallback, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, AlertTriangle, Wrench, Boxes } from 'lucide-react';
import { showToast } from '@/components/Toast';
import { slugifyName, type Skill } from '@/lib/connectors';
import type { McpServerConfig } from '@/lib/mcp';
import type { UseSkillsResult } from '@/hooks/useSkills';

export interface SkillsSectionProps {
  skills: UseSkillsResult['skills'];
  loading: boolean;
  validate: UseSkillsResult['validate'];
  save: UseSkillsResult['save'];
  remove: UseSkillsResult['remove'];
  /** Connectors available to bind to (for the select + name lookup). */
  servers: McpServerConfig[];
}

/** Split a comma-separated tool list into trimmed, de-duped, non-empty names. */
function parseToolNames(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export function SkillsSection({ skills, loading, validate, save, remove, servers }: SkillsSectionProps) {
  const [name, setName] = useState('');
  const [connectorId, setConnectorId] = useState('');
  const [toolsText, setToolsText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const serverNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of servers) m.set(s.id, s.name);
    return m;
  }, [servers]);

  const handleAdd = useCallback(async () => {
    const toolNames = parseToolNames(toolsText);
    const candidate: Skill = {
      id: slugifyName(name),
      name: name.trim(),
      description: '',
      connectorId: connectorId.trim(),
      toolNames,
    };

    const result = validate(candidate);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      await save(candidate);
      showToast(`Saved skill "${candidate.name}"`, 'success');
      setName('');
      setConnectorId('');
      setToolsText('');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save skill.', 'error');
    } finally {
      setSaving(false);
    }
  }, [name, connectorId, toolsText, validate, save]);

  return (
    <div className="space-y-3">
      {/* Existing skills */}
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-zinc-600">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="text-xs">Loading skills…</span>
        </div>
      ) : skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 py-4 text-center">
          <p className="text-[11px] italic text-zinc-500">No skills defined yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {skills.map((skill) => {
            const boundName = serverNameById.get(skill.connectorId);
            return (
              <div
                key={skill.id}
                data-testid="skill-row"
                className="rounded-xl border border-zinc-800/60 bg-[#050505]/50 p-3.5 transition-colors hover:border-[#ff7a18]/30"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h5 className="truncate text-sm font-semibold text-white">{skill.name}</h5>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-mono text-zinc-500">
                      <span className="inline-flex items-center gap-1">
                        <Boxes className="h-3 w-3 text-[#00e6ff]/80" />
                        {boundName ?? skill.connectorId}
                        {!boundName && (
                          <span className="text-amber-300/80">(unknown connector)</span>
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1 text-zinc-600">
                        <Wrench className="h-3 w-3" />
                        {skill.toolNames.length} {skill.toolNames.length === 1 ? 'tool' : 'tools'}
                      </span>
                    </div>
                  </div>

                  {confirmingId === skill.id ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingId(null);
                          void remove(skill.id);
                        }}
                        className="rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-500/20"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="rounded-lg border border-zinc-700/60 px-2.5 py-1.5 text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(skill.id)}
                      className="p-1.5 text-zinc-600 transition-all hover:bg-red-500/10 hover:text-red-400 rounded-lg"
                      title="Remove skill"
                      aria-label={`Remove skill ${skill.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {skill.toolNames.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {skill.toolNames.map((t) => (
                      <span
                        key={t}
                        className="rounded-md border border-zinc-800/60 bg-[#050505] px-1.5 py-0.5 text-[10px] font-mono text-zinc-400"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add skill */}
      <div className="rounded-xl border border-zinc-800/60 bg-[#050505]/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-[#ff7a18]" />
          <h5 className="text-sm font-semibold text-white">Add skill</h5>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="skill-name" className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            Name
          </label>
          <input
            id="skill-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Notion read-only"
            className="w-full rounded-lg border border-zinc-800/60 bg-[#050505] px-3 py-2.5 text-sm text-white placeholder:text-zinc-700 transition-colors hover:border-[#ff7a18]/30 focus:border-[#ff7a18]/60 focus:outline-none focus:ring-1 focus:ring-[#ff7a18]/25"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="skill-connector" className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            Connector
          </label>
          <select
            id="skill-connector"
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
            className="w-full rounded-lg border border-zinc-800/60 bg-[#050505] px-3 py-2.5 text-sm text-white transition-colors hover:border-[#ff7a18]/30 focus:border-[#ff7a18]/60 focus:outline-none focus:ring-1 focus:ring-[#ff7a18]/25"
          >
            <option value="">— Select a connector —</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="skill-tools" className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            Tool names <span className="font-normal normal-case text-zinc-600">(comma-separated)</span>
          </label>
          <input
            id="skill-tools"
            type="text"
            value={toolsText}
            onChange={(e) => setToolsText(e.target.value)}
            placeholder="search, fetch_page, create_page"
            className="w-full rounded-lg border border-zinc-800/60 bg-[#050505] px-3 py-2.5 text-sm font-mono text-white placeholder:text-zinc-700 transition-colors hover:border-[#ff7a18]/30 focus:border-[#ff7a18]/60 focus:outline-none focus:ring-1 focus:ring-[#ff7a18]/25"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {errors.length > 0 && (
          <ul role="alert" className="space-y-1">
            {errors.map((err, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11px] text-red-300">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {err}
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff7a18] px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-[#ff9d4d] active:bg-[#e8650a] disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add skill
        </button>
      </div>
    </div>
  );
}
