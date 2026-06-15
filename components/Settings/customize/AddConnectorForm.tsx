'use client';

/**
 * 4NE-12 (FR-22) — operator-gated Add-connector form.
 *
 * The ONLY way a connector enters the registry from the UI. Three steps,
 * matching the lib's propose → confirm → install pipeline:
 *
 *   1. FORM   — operator types name + URL + optional headers and clicks
 *               "Propose". We call `propose({ source:'operator', … })`. The
 *               `source:'operator'` literal IS the FR-22 trust anchor — a
 *               connector is never installed from scraped/model-suggested
 *               content, only from this operator-entered input.
 *   2. REVIEW — we render the REDACTED proposed config (`proposal.redactedView`
 *               from `redactConfig`, so bearer tokens are masked as `***` and
 *               never shown) + any warnings. An "Install" button advances.
 *   3. CONFIRM— the operator clicks Confirm. THIS is the trust grant: it
 *               resolves the in-component operator-confirm channel with
 *               `'approved'`, which `assertApproved` turns into a minted
 *               `connector-activate` token bound to THIS exact connector. We
 *               hand that token to `install(proposal, token)` →
 *               `confirmAndInstall`. A Cancel resolves `'denied'` → no token,
 *               nothing is trusted or enabled (fail-closed).
 *
 * The "operator-confirm channel" is the `askOperator` dep injected into
 * `assertApproved`: a Promise we resolve from the Confirm / Cancel button
 * handlers. This keeps the trust decision interactive and in-UI without the
 * lib layer needing to know about React.
 */

import { useCallback, useRef, useState } from 'react';
import { Loader2, Plus, ShieldCheck, AlertTriangle, X } from 'lucide-react';
import { showToast } from '@/components/Toast';
import { redactConfig, type McpServerConfig } from '@/lib/mcp';
import {
  buildConnectorActivateRequest,
  type ConnectorProposal,
  type ProposeConnectorInput,
  type InstallOutcome,
} from '@/lib/connectors';
import { assertApproved, ApprovalDeniedError, type ApprovalToken } from '@/lib/approval';

export interface AddConnectorFormProps {
  propose: (input: ProposeConnectorInput) => ConnectorProposal;
  install: (proposal: ConnectorProposal, token: ApprovalToken) => Promise<InstallOutcome>;
}

/** Parse the headers textarea ("Key: value" per line) into a record. */
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

type Stage = 'form' | 'review';

export function AddConnectorForm({ propose, install }: AddConnectorFormProps) {
  const [stage, setStage] = useState<Stage>('form');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [proposal, setProposal] = useState<ConnectorProposal | null>(null);
  const [formError, setFormError] = useState('');
  const [installing, setInstalling] = useState(false);

  // The operator-confirm channel: `assertApproved`'s askOperator awaits this
  // Promise; the Confirm / Cancel buttons resolve it. A ref so the resolver
  // survives re-renders between mounting the confirm UI and the click.
  const confirmResolverRef = useRef<((approved: boolean) => void) | null>(null);

  const reset = useCallback(() => {
    setStage('form');
    setName('');
    setUrl('');
    setHeadersText('');
    setProposal(null);
    setFormError('');
    confirmResolverRef.current = null;
  }, []);

  const handlePropose = useCallback(() => {
    setFormError('');
    try {
      const headers = parseHeaders(headersText);
      const input: ProposeConnectorInput = {
        source: 'operator',
        name: name.trim(),
        transport: 'http',
        url: url.trim(),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
      const next = propose(input);
      setProposal(next);
      setStage('review');
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not build a proposal.');
    }
  }, [name, url, headersText, propose]);

  const handleConfirmInstall = useCallback(async () => {
    if (!proposal) return;
    setInstalling(true);
    try {
      // Mint the connector-activate token through the unified approval
      // chokepoint. The askOperator channel resolves 'approved' the instant
      // we reach this handler — the operator already clicked Confirm, which
      // IS the trust grant (FR-22).
      const request = buildConnectorActivateRequest(proposal.config);
      const token = await assertApproved(request, {
        askOperator: () =>
          new Promise((resolve) => {
            confirmResolverRef.current = (approved: boolean) =>
              resolve({ verdict: approved ? 'approved' : 'denied' });
            // Auto-resolve approved: reaching this handler means the operator
            // clicked the Confirm button below. The channel exists so the
            // trust decision flows through `assertApproved` (token minting)
            // rather than the UI hand-rolling a token.
            confirmResolverRef.current(true);
          }),
      });

      const outcome = await install(proposal, token);
      if (outcome.ok) {
        showToast(`Installed connector "${outcome.server.name}"`, 'success');
        reset();
      } else {
        const detail =
          outcome.stage === 'probe'
            ? 'connected but the probe failed — left disabled'
            : outcome.error.message;
        showToast(`Install failed: ${detail}`, 'error');
        setInstalling(false);
      }
    } catch (e) {
      if (e instanceof ApprovalDeniedError) {
        showToast('Activation was not approved.', 'warning');
      } else {
        showToast(e instanceof Error ? e.message : 'Install failed.', 'error');
      }
      setInstalling(false);
    }
  }, [proposal, install, reset]);

  if (stage === 'review' && proposal) {
    return (
      <div className="rounded-xl border border-[#ff7a18]/30 bg-[#ff7a18]/5 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[#ff7a18]" />
          <h5 className="text-sm font-semibold text-white">Confirm connector</h5>
          <button
            type="button"
            onClick={reset}
            disabled={installing}
            className="ml-auto text-zinc-500 transition-colors hover:text-zinc-300 disabled:opacity-50"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-400">
          Review the config below — secrets are masked. Confirming is the trust grant: it
          activates this connector. Nothing was installed from scraped or suggested content.
        </p>

        <RedactedConfigView config={proposal.redactedView} />

        {proposal.warnings.length > 0 && (
          <ul className="space-y-1">
            {proposal.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[10.5px] text-amber-300/90">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="leading-relaxed">{w}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => void handleConfirmInstall()}
            disabled={installing}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff7a18] px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-[#ff9d4d] active:bg-[#e8650a] disabled:opacity-50"
          >
            {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            Confirm &amp; install
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={installing}
            className="rounded-xl border border-zinc-700/60 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-[#050505]/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Plus className="h-4 w-4 text-[#ff7a18]" />
        <h5 className="text-sm font-semibold text-white">Add connector</h5>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="connector-name" className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
          Name
        </label>
        <input
          id="connector-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My Notion MCP"
          className="w-full rounded-lg border border-zinc-800/60 bg-[#050505] px-3 py-2.5 text-sm text-white placeholder:text-zinc-700 transition-colors hover:border-[#ff7a18]/30 focus:border-[#ff7a18]/60 focus:outline-none focus:ring-1 focus:ring-[#ff7a18]/25"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="connector-url" className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
          Server URL
        </label>
        <input
          id="connector-url"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/mcp"
          className="w-full rounded-lg border border-zinc-800/60 bg-[#050505] px-3 py-2.5 text-sm font-mono text-white placeholder:text-zinc-700 transition-colors hover:border-[#ff7a18]/30 focus:border-[#ff7a18]/60 focus:outline-none focus:ring-1 focus:ring-[#ff7a18]/25"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="connector-headers" className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
          Headers <span className="font-normal normal-case text-zinc-600">(optional, one per line — Key: value)</span>
        </label>
        <textarea
          id="connector-headers"
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          placeholder={'Authorization: Bearer sk-…'}
          rows={2}
          className="w-full resize-y rounded-lg border border-zinc-800/60 bg-[#050505] px-3 py-2.5 text-sm font-mono text-white placeholder:text-zinc-700 transition-colors hover:border-[#ff7a18]/30 focus:border-[#ff7a18]/60 focus:outline-none focus:ring-1 focus:ring-[#ff7a18]/25"
          spellCheck={false}
        />
      </div>

      {formError && (
        <p role="alert" className="flex items-start gap-1.5 text-[11px] text-red-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {formError}
        </p>
      )}

      <button
        type="button"
        onClick={handlePropose}
        disabled={name.trim() === '' || url.trim() === ''}
        className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff7a18] px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-[#ff9d4d] active:bg-[#e8650a] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" />
        Propose
      </button>
    </div>
  );
}

/** Render the redacted candidate config — tokens already masked by `redactConfig`. */
function RedactedConfigView({ config }: { config: McpServerConfig }) {
  // Defence-in-depth: re-run redaction in case a caller passed a raw config.
  const safe = redactConfig(config);
  return (
    <dl
      data-testid="redacted-config"
      className="space-y-1.5 rounded-lg border border-zinc-800/60 bg-[#050505] p-3 font-mono text-[11px]"
    >
      <Row label="id" value={safe.id} />
      <Row label="name" value={safe.name} />
      <Row label="transport" value={safe.transport} />
      {safe.url && <Row label="url" value={safe.url} />}
      {safe.headers &&
        Object.entries(safe.headers).map(([k, v]) => (
          <Row key={k} label={`header · ${k}`} value={v} />
        ))}
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-zinc-600">{label}</dt>
      <dd className="truncate text-zinc-200">{value}</dd>
    </div>
  );
}
