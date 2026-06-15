'use client';

/**
 * 4NE-12 — Connectors manager state hook.
 *
 * Thin reactive wrapper around the `@/lib/connectors` + `@/lib/mcp` public
 * surface. ALL the heavy lifting (the FR-22 propose → confirm → install
 * pipeline, persistence, the health probe) stays in the lib layer; this hook
 * only loads the registry, fans out a health check per connector, and exposes
 * the mutators the CustomizePanel UI calls + re-renders on.
 *
 * Mirrors the lazy-load + in-memory mutate pattern of the other hooks
 * (useImages / useSocial): the lib layer is authoritative for persistence;
 * the hook keeps a render-state copy and re-reads from the lib after each
 * mutation rather than guessing the next state.
 *
 * The operator-confirm channel for activation is NOT minted here — the panel
 * owns that interactive step (a Confirm button) and hands the minted token
 * down to `install()`. This hook is provider-agnostic about how the token was
 * obtained; it just forwards it to `confirmAndInstall`.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  listServers,
  setEnabled as mcpSetEnabled,
  type McpServerConfig,
} from '@/lib/mcp';
import {
  proposeConnector,
  confirmAndInstall,
  uninstallConnector,
  checkConnectorHealth,
  checkAllConnectors,
  type ConnectorProposal,
  type ProposeConnectorInput,
  type InstallOutcome,
  type ConnectorHealth,
} from '@/lib/connectors';
import type { ApprovalToken } from '@/lib/approval';

export interface UseConnectorsResult {
  /** The persisted connector registry, in stored order. */
  servers: McpServerConfig[];
  /** Health verdict per connector id (keyed by `config.id`). */
  health: Record<string, ConnectorHealth>;
  /** True until the first registry + health load resolves. */
  loading: boolean;
  /** Reload the registry and re-run the full health sweep. */
  refresh: () => Promise<void>;
  /** Toggle a connector's `enabled` flag, then refresh its health. */
  toggle: (id: string, on: boolean) => Promise<void>;
  /** Re-probe a single connector and fold the result into `health`. */
  test: (id: string) => Promise<ConnectorHealth | undefined>;
  /** Remove a connector by id and reload. */
  remove: (id: string) => Promise<void>;
  /** FR-22 step 1: build a (non-persisted) proposal from operator input. */
  propose: (input: ProposeConnectorInput) => ConnectorProposal;
  /** FR-22 step 2: commit the operator-confirmed proposal with its token. */
  install: (proposal: ConnectorProposal, token: ApprovalToken) => Promise<InstallOutcome>;
}

export function useConnectors(): UseConnectorsResult {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [health, setHealth] = useState<Record<string, ConnectorHealth>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [list, checks] = await Promise.all([listServers(), checkAllConnectors()]);
    setServers(list);
    const byId: Record<string, ConnectorHealth> = {};
    for (const h of checks) byId[h.id] = h;
    setHealth(byId);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const test = useCallback(async (id: string) => {
    const list = await listServers();
    const cfg = list.find((s) => s.id === id);
    if (!cfg) return undefined;
    const result = await checkConnectorHealth(cfg);
    setHealth((prev) => ({ ...prev, [id]: result }));
    return result;
  }, []);

  const toggle = useCallback(
    async (id: string, on: boolean) => {
      await mcpSetEnabled(id, on);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await uninstallConnector(id);
      await refresh();
    },
    [refresh],
  );

  const propose = useCallback(
    (input: ProposeConnectorInput) => proposeConnector(input, Date.now()),
    [],
  );

  const install = useCallback(
    async (proposal: ConnectorProposal, token: ApprovalToken) => {
      const outcome = await confirmAndInstall(proposal, token);
      // Whatever the outcome, the registry may have changed (a probe failure
      // still leaves the connector persisted-but-disabled), so resync.
      await refresh();
      return outcome;
    },
    [refresh],
  );

  return { servers, health, loading, refresh, toggle, test, remove, propose, install };
}
