'use client';

/**
 * 4NE-12 — a single connector row in the Connectors manager.
 *
 * Shows the connector name + transport + a status pill (driven by the live
 * `ConnectorHealth.status`), an enabled toggle (→ `setEnabled` via the hook),
 * a Test button (→ `checkConnectorHealth`), and a Remove button that requires
 * an inline confirm before it actually uninstalls. The row never touches the
 * lib directly — every action is a callback the panel wires to `useConnectors`.
 */

import { useState } from 'react';
import { Loader2, Trash2, Activity } from 'lucide-react';
import type { McpServerConfig } from '@/lib/mcp';
import type { ConnectorHealth } from '@/lib/connectors';
import { Switch } from '../Switch';
import { StatusPill } from './StatusPill';

export interface ConnectorRowProps {
  server: McpServerConfig;
  health: ConnectorHealth | undefined;
  onToggle: (id: string, on: boolean) => void | Promise<void>;
  onTest: (id: string) => void | Promise<unknown>;
  onRemove: (id: string) => void | Promise<void>;
}

export function ConnectorRow({ server, health, onToggle, onTest, onRemove }: ConnectorRowProps) {
  const [testing, setTesting] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const status = health?.status ?? 'checking';

  const handleTest = async () => {
    setTesting(true);
    try {
      await onTest(server.id);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      data-testid="connector-row"
      className="rounded-xl border border-zinc-800/60 bg-[#050505]/50 p-3.5 hover:border-[#ff7a18]/30 transition-colors"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h5 className="truncate text-sm font-semibold text-white">{server.name}</h5>
            <StatusPill status={status} />
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-zinc-500">
            <span className="uppercase tracking-wider text-[#00e6ff]/80">{server.transport}</span>
            {server.url && <span className="truncate">{server.url}</span>}
            {status === 'ok' && health?.toolCount !== undefined && (
              <span className="text-zinc-600">· {health.toolCount} tools</span>
            )}
          </div>
        </div>
        <Switch
          checked={server.enabled}
          onChange={(next) => void onToggle(server.id, next)}
          label={server.name}
          size="sm"
        />
      </div>

      {/* Failure detail — surfaced from the health probe so the operator can act. */}
      {health?.error && status !== 'ok' && status !== 'disabled' && (
        <p className="mt-2 text-[10.5px] leading-relaxed text-red-300/80">{health.error}</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#00e6ff]/40 bg-[#00e6ff]/5 px-2.5 py-1.5 text-[11px] font-medium text-[#00e6ff] transition-colors hover:bg-[#00e6ff]/10 disabled:opacity-50"
        >
          {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
          Test
        </button>

        {confirmingRemove ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-zinc-400">Remove?</span>
            <button
              type="button"
              onClick={() => {
                setConfirmingRemove(false);
                void onRemove(server.id);
              }}
              className="rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-500/20"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemove(false)}
              className="rounded-lg border border-zinc-700/60 px-2.5 py-1.5 text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingRemove(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800/60 px-2.5 py-1.5 text-[11px] font-medium text-zinc-400 transition-colors hover:border-red-500/40 hover:text-red-300"
          >
            <Trash2 className="h-3 w-3" />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
