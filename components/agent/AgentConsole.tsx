'use client';

/**
 * AGENTIC-CORE / PHASE 1 — "Kael's Cyberforge Console".
 *
 * The NEW character-faithful agentic chat console, wired to the tool-loop
 * agent. Unlike the legacy Sidebar chat (`mode:'chat'`, plain tool-less
 * MiniMax stream), this console drives the Director loop (the `ToolLoopAgent`
 * with `AGENT_TOOLS`) via `streamAgent` — so the in-app agent FINALLY uses
 * tools: it plans the beat, drafts a canon scene with `generate_prompt`,
 * critiques it, then calls `generate_image` → Higgsfield (Element-anchored),
 * and the produced beats land back in the thread.
 *
 * The console renders, per agent turn:
 *   - the operator's prompt bubble (cyan, right-aligned),
 *   - the agent's reasoning bubbles (ashen, left-aligned),
 *   - tool-call chips (cyan, JetBrains Mono — "generate_image · Higgsfield"),
 *   - produced-beat thumbnails (from a generate_image/video AssetRef),
 *   - a final prompt + run-cost footer when the loop finishes.
 *
 * The MCP connector registry + skills + character all live CLIENT-side, so we
 * resolve them here (useConnectors / useSkills / useSettings) and thread them
 * into `streamAgent`; the route reads them out of the request body.
 *
 * This is ADDITIVE — the legacy Sidebar/MainContent stay reachable. The
 * right-rail approval-deck + canon panels are deferred to a later phase (see
 * the report); for now the console is a focused, polished primary surface.
 *
 * Cyberforge palette (already in app/globals.css):
 *   agency black #050505/#0a0b0d surfaces · AIART4NEVER orange #ff7a18
 *   (primary/active) · electric cyan #00e6ff (secondary/tool-calls) ·
 *   ashen #8a97a6 neutrals · Space Grotesk (UI) + JetBrains Mono (chips).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Send,
  Loader2,
  Wrench,
  Sparkles,
  Image as ImageIcon,
  AlertTriangle,
  Cpu,
  Coins,
} from 'lucide-react';
import { useConnectors } from '@/hooks/useConnectors';
import { useSkills } from '@/hooks/useSkills';
import { useSettings } from '@/hooks/useSettings';
import { listCharacters, type CharacterId } from '@/lib/canon';
import { streamAgent, type AgentAssetRef } from '@/lib/aiClient';
import type { McpServerConfig } from '@/lib/mcp';

// ── Thread model ────────────────────────────────────────────────────────────

interface ToolCallEntry {
  /** Stable per-turn id so React keys don't collide across rapid events. */
  key: string;
  tool: string;
  args?: unknown;
  /** Filled in when the matching tool-result arrives. */
  done?: boolean;
}

interface AgentTurn {
  id: string;
  role: 'operator' | 'agent';
  /** Operator text, or the agent's accumulated reasoning. */
  text: string;
  /** Agent-only: tool-call chips in call order. */
  toolCalls?: ToolCallEntry[];
  /** Agent-only: produced beat assets (image/video). */
  assets?: AgentAssetRef[];
  /** Agent-only: still streaming. */
  streaming?: boolean;
  /** Agent-only: terminal run footer. */
  cost?: number;
  truncatedBy?: string;
  /** Agent-only: hard failure surfaced in-thread. */
  error?: string;
}

/**
 * AGENTIC-CORE: pick the operator's usable Higgsfield connector — enabled +
 * trusted, name matches /higgsfield/i. Mirrors the server's
 * `readHiggsfieldConnector` matching so the console and route agree on which
 * connector the agent will use.
 */
export function pickHiggsfieldConnector(
  servers: McpServerConfig[],
): McpServerConfig | undefined {
  return servers.find(
    (s) => s.enabled && s.trusted && /higgsfield/i.test(s.name),
  );
}

// ── Component ─────────────────────────────────────────────────────────────

export function AgentConsole() {
  const { servers } = useConnectors();
  const { skills } = useSkills();
  const { settings } = useSettings();

  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const higgsfieldConnector = useMemo(
    () => pickHiggsfieldConnector(servers),
    [servers],
  );

  const characterId = (settings.activeCharacterId ?? 'kael') as CharacterId;
  const character = useMemo(
    () => listCharacters().find((c) => c.id === characterId),
    [characterId],
  );

  // Resolve the active skills the operator enabled (settings.activeSkills) and
  // pass them to the loop so the prompt template folds them in. We only need
  // the names; the loader hydrates the bodies server-side.
  const activeSkillRefs = useMemo(() => {
    const enabled = new Set(settings.activeSkills ?? []);
    // Prefer skill names from the persisted skills registry; fall back to the
    // raw settings names so a skill enabled-but-not-yet-in-registry still flows.
    const fromRegistry = skills
      .filter((s) => enabled.has(s.id) || enabled.has(s.name))
      .map((s) => ({ name: s.name }));
    if (fromRegistry.length > 0) return fromRegistry;
    return (settings.activeSkills ?? []).map((name) => ({ name }));
  }, [skills, settings.activeSkills]);

  const niches = settings.agentNiches?.length
    ? settings.agentNiches
    : ['Story-Beat'];
  const genres = settings.agentGenres ?? [];

  const scrollToBottom = useCallback(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [turns, scrollToBottom]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleSend = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || isRunning) return;
      if (!override) setInput('');
      setIsRunning(true);

      const operatorId = `op_${Date.now()}`;
      const agentId = `ag_${Date.now() + 1}`;
      setTurns((prev) => [
        ...prev,
        { id: operatorId, role: 'operator', text },
        {
          id: agentId,
          role: 'agent',
          text: '',
          toolCalls: [],
          assets: [],
          streaming: true,
        },
      ]);

      const patchAgent = (patch: (t: AgentTurn) => AgentTurn) =>
        setTurns((prev) => prev.map((t) => (t.id === agentId ? patch(t) : t)));

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const ev of streamAgent(text, {
          niches,
          genres,
          characterId,
          higgsfieldConnector,
          skills: activeSkillRefs,
          model: settings.activeTextModel,
          higgsfieldCliToken: settings.higgsfieldCliToken,
          userId: 'agent-console',
          signal: controller.signal,
        })) {
          if (ev.type === 'plan') {
            // BUGFIX (live chat): the internal director-plan scaffold is
            // Replay-UI-only and must NEVER render as the agent's visible
            // message. The stream layer already strips its text (emits a bare
            // {type:'plan'} marker); we simply ignore it here. The bubble stays
            // in its "Planning…" state until real assistant text arrives.
          } else if (ev.type === 'text') {
            // Append the reasoning delta (final / error-step text). Defense in
            // depth: drop any stray plan-step text so the scaffold can never
            // leak into the thread even if an upstream layer changes.
            if (
              ev.stepType !== 'plan' &&
              ev.text &&
              ev.text.trim().length > 0
            ) {
              patchAgent((t) => ({
                ...t,
                text: t.text ? `${t.text}\n\n${ev.text}` : ev.text,
              }));
            }
          } else if (ev.type === 'tool-call') {
            patchAgent((t) => ({
              ...t,
              toolCalls: [
                ...(t.toolCalls ?? []),
                {
                  key: `${ev.idx ?? t.toolCalls?.length ?? 0}_${ev.tool}`,
                  tool: ev.tool,
                  args: ev.args,
                },
              ],
            }));
          } else if (ev.type === 'tool-result') {
            patchAgent((t) => {
              const calls = [...(t.toolCalls ?? [])];
              // Mark the latest matching unfinished call done.
              for (let i = calls.length - 1; i >= 0; i--) {
                if (calls[i].tool === ev.tool && !calls[i].done) {
                  calls[i] = { ...calls[i], done: true };
                  break;
                }
              }
              const assets = [...(t.assets ?? [])];
              if (ev.assetRef && !assets.some((a) => a.id === ev.assetRef!.id)) {
                assets.push(ev.assetRef);
              }
              return { ...t, toolCalls: calls, assets };
            });
          } else if (ev.type === 'done') {
            patchAgent((t) => ({
              ...t,
              streaming: false,
              cost: ev.cost,
              truncatedBy: ev.truncatedBy,
              // If the agent produced a final prompt but no terminal reasoning,
              // surface the prompt so the bubble is never empty.
              text:
                t.text.trim().length > 0
                  ? t.text
                  : ev.prompt || t.text,
            }));
          } else if (ev.type === 'error') {
            patchAgent((t) => ({
              ...t,
              streaming: false,
              error: ev.error,
            }));
          }
        }
        // Stream ended without an explicit done/error (e.g. transport close).
        patchAgent((t) => (t.streaming ? { ...t, streaming: false } : t));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Agent run failed.';
        patchAgent((t) => ({ ...t, streaming: false, error: msg }));
      } finally {
        setIsRunning(false);
        abortRef.current = null;
      }
    },
    [
      input,
      isRunning,
      niches,
      genres,
      characterId,
      higgsfieldConnector,
      activeSkillRefs,
      settings.activeTextModel,
      settings.higgsfieldCliToken,
    ],
  );

  return (
    <section
      aria-label="Agent console"
      data-testid="agent-console"
      className="flex flex-col h-full min-w-0 flex-1 bg-[#050505]"
    >
      {/* Header */}
      <header className="flex items-center gap-3 px-5 py-3.5 border-b border-[#ff7a18]/20 bg-[#0a0b0d]/80">
        <div className="w-9 h-9 rounded-xl bg-[#ff7a18]/10 border border-[#ff7a18]/30 flex items-center justify-center shrink-0">
          <Cpu className="w-5 h-5 text-[#ff7a18]" />
        </div>
        <div className="min-w-0">
          <h1
            className="text-sm font-bold text-white tracking-tight truncate"
            style={{ fontFamily: 'var(--font-sans)' }}
          >
            Cyberforge Console
          </h1>
          <p className="text-[11px] text-[#8a97a6] truncate">
            Agentic · {character?.name ?? 'Master4never (Kael)'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {higgsfieldConnector ? (
            <span
              data-testid="connector-pill"
              className="text-[10px] font-mono px-2 py-1 rounded-lg bg-[#00e6ff]/10 text-[#00e6ff] border border-[#00e6ff]/25"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {higgsfieldConnector.name}
            </span>
          ) : (
            <span
              data-testid="connector-pill-missing"
              className="text-[10px] font-mono px-2 py-1 rounded-lg bg-[#ff7a18]/10 text-[#ff9d4d] border border-[#ff7a18]/25"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              no connector
            </span>
          )}
        </div>
      </header>

      {/* No-Higgsfield hint */}
      {!higgsfieldConnector && (
        <div
          data-testid="no-connector-hint"
          className="mx-5 mt-4 flex items-start gap-2.5 rounded-xl bg-[#ff7a18]/8 border border-[#ff7a18]/25 px-4 py-3"
        >
          <AlertTriangle className="w-4 h-4 text-[#ff9d4d] shrink-0 mt-0.5" />
          <p className="text-xs text-[#ffd9b8] leading-relaxed">
            No Higgsfield connector — add one in <strong>Customize</strong> so
            the agent can generate beats. You can still chat and plan; image
            tools will report the missing connector.
          </p>
        </div>
      )}

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
        {turns.length === 0 && (
          <div
            data-testid="agent-intro"
            className="text-center mt-12 flex flex-col items-center gap-5"
          >
            <div className="w-14 h-14 rounded-2xl bg-[#ff7a18]/10 border border-[#ff7a18]/30 flex items-center justify-center">
              <Sparkles className="w-7 h-7 text-[#ff7a18]" />
            </div>
            <div className="max-w-md">
              <h2 className="text-base font-bold text-white mb-1.5">
                Direct the forge
              </h2>
              <p className="text-sm text-[#8a97a6] leading-relaxed">
                Describe a beat for {character?.name ?? 'Kael'} across the
                multiverse. The agent will plan, draft an on-canon prompt, and
                call its tools — including{' '}
                <span className="font-mono text-[#00e6ff]">generate_image</span>{' '}
                via Higgsfield — to forge it.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                handleSend(
                  'Forge a Variant Reveal beat: Kael stepping through a reality rift into a storm-wreathed sky-temple. Plan it, draft the on-canon prompt, then generate the image.',
                )
              }
              disabled={isRunning}
              className="flex items-center gap-2 px-4 py-2 bg-[#ff7a18]/10 hover:bg-[#ff7a18]/20 border border-[#ff7a18]/30 hover:border-[#ff7a18]/55 text-[#ff9d4d] rounded-xl transition-all duration-200 font-semibold text-sm disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              Forge a beat
            </button>
          </div>
        )}

        {turns.map((turn) =>
          turn.role === 'operator' ? (
            <div key={turn.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#00e6ff] text-[#050505] px-4 py-2.5 text-sm font-medium">
                {turn.text}
              </div>
            </div>
          ) : (
            <div
              key={turn.id}
              data-testid="agent-turn"
              className="flex flex-col items-start gap-2.5 max-w-[92%]"
            >
              {/* Reasoning bubble */}
              {(turn.text || turn.streaming) && (
                <div className="rounded-2xl rounded-bl-sm bg-[#0f1114] border border-[#ff7a18]/12 text-[#cdd6e0] px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed">
                  {turn.text || (
                    <span className="text-[#8a97a6] italic">Planning…</span>
                  )}
                  {turn.streaming && (
                    <span className="inline-block w-2 h-4 bg-[#ff7a18] ml-1 align-middle animate-pulse" />
                  )}
                </div>
              )}

              {/* Tool-call chips */}
              {turn.toolCalls && turn.toolCalls.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {turn.toolCalls.map((tc) => (
                    <span
                      key={tc.key}
                      data-testid="tool-call-chip"
                      className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg bg-[#00e6ff]/8 text-[#00e6ff] border border-[#00e6ff]/25"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {tc.done ? (
                        <Wrench className="w-3 h-3" />
                      ) : (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      )}
                      {tc.tool}
                      {describeToolArgs(tc.tool, tc.args)}
                    </span>
                  ))}
                </div>
              )}

              {/* Produced beat thumbnails */}
              {turn.assets && turn.assets.length > 0 && (
                <div
                  data-testid="agent-assets"
                  className="grid grid-cols-2 gap-2 w-full max-w-sm"
                >
                  {turn.assets.map((a) => (
                    <a
                      key={a.id}
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group relative aspect-square rounded-xl overflow-hidden border border-[#ff7a18]/20 hover:border-[#ff7a18]/55 transition-all bg-[#0a0b0d]"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={a.url}
                        alt={`Generated beat (${a.provider})`}
                        loading="lazy"
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                      <span
                        className="absolute bottom-1 left-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-black/70 text-[#00e6ff]"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      >
                        {a.provider}
                      </span>
                    </a>
                  ))}
                </div>
              )}

              {/* Error */}
              {turn.error && (
                <div
                  data-testid="agent-error"
                  className="flex items-start gap-2 rounded-xl bg-red-500/8 border border-red-500/30 px-3.5 py-2.5 text-xs text-red-300 leading-relaxed max-w-md"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  {turn.error}
                </div>
              )}

              {/* Run footer */}
              {!turn.streaming && typeof turn.cost === 'number' && !turn.error && (
                <div className="flex items-center gap-1.5 text-[10px] text-[#8a97a6] font-mono" style={{ fontFamily: 'var(--font-mono)' }}>
                  <Coins className="w-3 h-3 text-[#ff7a18]" />
                  ${turn.cost.toFixed(4)}
                  {turn.truncatedBy && turn.truncatedBy !== 'natural' && (
                    <span className="text-[#ff9d4d]">· {turn.truncatedBy}</span>
                  )}
                </div>
              )}
            </div>
          ),
        )}
        <div ref={threadEndRef} />
      </div>

      {/* Input bar */}
      <div className="p-4 border-t border-[#ff7a18]/20 bg-[#0a0b0d]/90">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
          className="relative"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Direct the agent — describe a beat to forge…"
            aria-label="Message the agent"
            rows={2}
            disabled={isRunning}
            className="w-full resize-none bg-[#050505] border border-[#ff7a18]/20 rounded-xl pl-4 pr-12 py-3 text-sm text-white placeholder:text-[#5b6672] focus:outline-none focus:ring-2 focus:ring-[#ff7a18]/30 focus:border-[#ff7a18]/45 transition-all disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!input.trim() || isRunning}
            aria-label="Send to agent"
            className="absolute right-2.5 bottom-2.5 p-2 rounded-lg bg-[#ff7a18] text-[#050505] hover:bg-[#ff9d4d] disabled:opacity-40 disabled:hover:bg-[#ff7a18] transition-colors"
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </form>
      </div>
    </section>
  );
}

/**
 * Compact, character-faithful arg hint for a tool-call chip, e.g.
 * "generate_image · Higgsfield · <<<Kael>>>". Best-effort — unknown shapes
 * render no suffix so the chip stays clean.
 */
function describeToolArgs(tool: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  if (tool === 'generate_image' || tool === 'generate_video') {
    const model = typeof a.model === 'string' ? a.model : undefined;
    return model ? ` · ${model}` : ' · Higgsfield';
  }
  return '';
}
