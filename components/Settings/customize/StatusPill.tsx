'use client';

/**
 * 4NE-12 — connector health status pill.
 *
 * Maps a `ConnectorHealth.status` to a legible, Ashen-Cyberforge-toned chip:
 *   - `ok`           → orange/green (reachable, trusted) — the success tone.
 *   - `disabled`     → ashen (operator switched it off; not probed).
 *   - `unreachable` / `auth-error` / `error` → red (a real problem).
 * Driven entirely by status; the panel passes the live verdict in.
 */

import type { ConnectorHealthStatus } from '@/lib/connectors';

const PILL: Record<
  ConnectorHealthStatus | 'checking',
  { label: string; className: string }
> = {
  ok: {
    label: 'Connected',
    className: 'bg-[#ff7a18]/15 text-[#ff7a18] border border-[#ff7a18]/40',
  },
  disabled: {
    label: 'Disabled',
    className: 'bg-zinc-800/60 text-zinc-400 border border-zinc-700/60',
  },
  unreachable: {
    label: 'Unreachable',
    className: 'bg-red-500/15 text-red-300 border border-red-500/40',
  },
  'auth-error': {
    label: 'Auth error',
    className: 'bg-red-500/15 text-red-300 border border-red-500/40',
  },
  error: {
    label: 'Error',
    className: 'bg-red-500/15 text-red-300 border border-red-500/40',
  },
  checking: {
    label: 'Checking…',
    className: 'bg-zinc-800/60 text-zinc-500 border border-zinc-700/60',
  },
};

export function StatusPill({
  status,
}: {
  status: ConnectorHealthStatus | 'checking';
}) {
  const pill = PILL[status] ?? PILL.checking;
  return (
    <span
      data-testid="status-pill"
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${pill.className}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === 'ok'
            ? 'bg-[#ff7a18]'
            : status === 'disabled' || status === 'checking'
              ? 'bg-zinc-500'
              : 'bg-red-400'
        }`}
        aria-hidden={true}
      />
      {pill.label}
    </span>
  );
}
