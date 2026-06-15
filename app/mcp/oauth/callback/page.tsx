'use client';

/**
 * MCP OAuth 2.1 — redirect_uri callback page.
 *
 * This is the `redirect_uri` target the authorization server (e.g. Higgsfield)
 * sends the browser back to after the user authorizes. Per `lib/mcp/oauth.ts`
 * the redirect_uri is `<origin>/mcp/oauth/callback` for BOTH deploy targets:
 *   - hosted web (Vercel): https://<vercel-host>/mcp/oauth/callback
 *   - desktop (Tauri):     the app origin + /mcp/oauth/callback
 *
 * Flow when we land here:
 *   1. Read `?code` / `?state` (or an OAuth `?error=...`).
 *   2. `completeConnectorOAuth(code, state)` → the SDK exchanges the code for
 *      tokens (PKCE verifier + DCR client info were stashed at begin time) and
 *      returns the connector config with its `oauth` block + Bearer header set.
 *   3. Commit it through the SAME FR-22 install pipeline the Add form uses:
 *      proposeConnector → mint a `connector-activate` token (completing the
 *      browser login IS the operator's consent) → confirmAndInstall with the
 *      server-side probe deps. The probe now succeeds with the Bearer token, so
 *      the connector lands trusted + enabled.
 *   4. Route back to /studio with a success / failure flag.
 *
 * The page never shows raw tokens. Errors are surfaced as a Retry/back state.
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { completeConnectorOAuth } from '@/lib/mcp';
import {
  proposeConnector,
  confirmAndInstall,
  serverProbeDeps,
  buildConnectorActivateRequest,
} from '@/lib/connectors';
import { assertApproved } from '@/lib/approval';
import { getErrorMessage } from '@/lib/errors';

type Phase = 'working' | 'success' | 'error';

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [phase, setPhase] = useState<Phase>('working');
  const [message, setMessage] = useState('Completing authorization…');
  const [connectorName, setConnectorName] = useState('');
  // Guard against React 18/19 StrictMode double-invoke: the code is single-use.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    void (async () => {
      const oauthError = params.get('error');
      if (oauthError) {
        const desc = params.get('error_description');
        setPhase('error');
        setMessage(desc ? `${oauthError}: ${desc}` : `Authorization failed: ${oauthError}`);
        return;
      }

      const code = params.get('code');
      const state = params.get('state') ?? undefined;
      if (!code) {
        setPhase('error');
        setMessage('Authorization response was missing the code parameter.');
        return;
      }

      try {
        // 1+2. Exchange the code for tokens and fold them into the config.
        const { config } = await completeConnectorOAuth(code, state);
        setConnectorName(config.name);

        // 3. Commit through the FR-22 install pipeline. The config already
        //    carries the Bearer header, so proposeConnector re-validates the
        //    same shape and confirmAndInstall's server-side probe authenticates.
        const proposal = proposeConnector(
          {
            source: 'operator',
            name: config.name,
            transport: 'http',
            ...(config.url ? { url: config.url } : {}),
            ...(config.headers ? { headers: config.headers } : {}),
          },
          Date.now(),
        );
        // Re-attach the oauth credential block onto the proposal config (propose
        // only carries the operator form fields; the refresh token lives here).
        const configToInstall = { ...proposal.config, oauth: config.oauth };

        // The operator already consented by initiating the OAuth login and
        // completing it at the provider — mint the activation token through the
        // unified chokepoint (auto-approve, mirroring the Add form).
        const request = buildConnectorActivateRequest(configToInstall);
        const token = await assertApproved(request, {
          askOperator: () => Promise.resolve({ verdict: 'approved' as const }),
        });

        const outcome = await confirmAndInstall(
          { ...proposal, config: configToInstall },
          token,
          serverProbeDeps,
        );

        if (outcome.ok) {
          setPhase('success');
          setMessage(`Connected "${outcome.server.name}".`);
          // Brief success flash, then back to the studio.
          setTimeout(() => router.replace('/studio?connector=connected'), 1200);
        } else {
          setPhase('error');
          setMessage(
            outcome.stage === 'probe'
              ? 'Authorized, but the server probe failed — the connector was left disabled.'
              : `Install failed: ${outcome.error.message}`,
          );
        }
      } catch (e) {
        setPhase('error');
        setMessage(getErrorMessage(e));
      }
    })();
  }, [params, router]);

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="card w-full max-w-md p-8 text-center space-y-4">
        {phase === 'working' && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#00e6ff]" />
            <h1 className="type-display text-xl">Authorizing connector</h1>
            <p className="type-muted text-sm">{message}</p>
          </>
        )}
        {phase === 'success' && (
          <>
            <ShieldCheck className="mx-auto h-8 w-8 text-emerald-400" />
            <h1 className="type-display text-xl">Connector authorized</h1>
            <p className="type-muted text-sm">{message}</p>
            <p className="type-caption text-zinc-600">Returning to the studio…</p>
          </>
        )}
        {phase === 'error' && (
          <>
            <AlertTriangle className="mx-auto h-8 w-8 text-red-400" />
            <h1 className="type-display text-xl">Authorization failed</h1>
            <p role="alert" className="type-muted text-sm text-red-300">
              {message}
            </p>
            <button
              type="button"
              onClick={() => router.replace('/studio?connector=error')}
              className="btn-cta mx-auto mt-2 px-5 py-2.5 text-xs"
            >
              Back to studio
            </button>
          </>
        )}
        {connectorName && phase !== 'error' && (
          <p className="type-caption text-zinc-700">{connectorName}</p>
        )}
      </div>
    </div>
  );
}

export default function McpOAuthCallbackPage() {
  // useSearchParams requires a Suspense boundary in the Next.js app router.
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[#00e6ff]" />
        </div>
      }
    >
      <CallbackInner />
    </Suspense>
  );
}
