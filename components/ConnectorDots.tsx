'use client';

/**
 * AGENTIC-CORE / PHASE 2 — topbar connector status dots.
 *
 * Higgsfield + Composio reachability indicators for the Cyberforge command bar.
 * Reads the REAL connector health sweep (`useConnectors().health`, keyed by
 * config id; `status: 'ok'` means reachable) and resolves each named connector
 * by a name match. Cyan + glow = connected; ashen = not present/not reachable.
 *
 * Split into its own module + dynamically imported by {@link StudioTopbar} on
 * purpose: `useConnectors` pulls the `@/lib/connectors` + MCP-SDK machinery,
 * which is heavy. The AgentConsole already lazy-loads it; keeping the topbar's
 * connector probe lazy too keeps the always-mounted `/studio` first-load bundle
 * under budget (the rest of the topbar — wordmark, toggle, character switcher,
 * budget — is lightweight and stays static).
 */

import { useConnectors } from '@/hooks/useConnectors';

export function ConnectorDots() {
  const { servers, health } = useConnectors();
  const isUp = (re: RegExp) =>
    servers.some(
      (s) => re.test(s.name) && s.enabled && health[s.id]?.status === 'ok',
    );
  const dots: Array<{ label: string; on: boolean }> = [
    { label: 'Higgsfield', on: isUp(/higgsfield/i) },
    { label: 'Composio', on: isUp(/composio/i) },
  ];
  return (
    <div className="flex items-center gap-2" data-testid="connector-dots">
      {dots.map(({ label, on }) => (
        <span
          key={label}
          title={`${label}: ${on ? 'connected' : 'not connected'}`}
          data-testid={`connector-dot-${label.toLowerCase()}`}
          data-on={on ? 'true' : 'false'}
          className="flex items-center gap-1"
        >
          <span className={`conn-dot ${on ? 'conn-dot-on' : ''}`} aria-hidden />
          <span className="text-[10px] text-[#8a97a6] hidden lg:inline">
            {label}
          </span>
        </span>
      ))}
    </div>
  );
}
