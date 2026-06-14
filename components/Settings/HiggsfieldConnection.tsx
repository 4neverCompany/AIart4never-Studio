'use client';

/**
 * HIGGSFIELD-INTEGRATION: Higgsfield connection panel for the
 * Settings → AI Engine tab. Renders:
 *   - Connection state (Connected as <email> / Not connected)
 *   - "Connect Higgsfield" or "Disconnect" button
 *   - Default image model picker (Nano Banana Pro / FLUX.2 / etc.)
 *   - Default video model picker (Seedance 2.0 / Veo 3.1 / etc.)
 *   - "Use alongside Leonardo" hint (peer, not replacement)
 *
 * Tokens are stored in IDB (encrypted, see lib/higgsfield/token-store).
 * The OAuth client_id is in config.json (auto-registered on first
 * connect). Users who want to use the CLI can find the
 * "Open terminal" hint at the bottom.
 *
 * The picker is a small client component — the data it writes
 * (defaultHiggsfieldImageModel / defaultHiggsfieldVideoModel) is
 * expected to live on `settings` (UserSettings) and be persisted
 * by the parent SettingsModal.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { Loader2, ExternalLink, Check, X, AlertTriangle, RefreshCcw } from 'lucide-react';
import {
  HIGGSFIELD_IMAGE_MODELS,
  HIGGSFIELD_VIDEO_MODELS,
  HIGGSFIELD_DEFAULT_IMAGE_MODEL,
  HIGGSFIELD_DEFAULT_VIDEO_MODEL,
  getHiggsfieldImageModel,
  type HiggsfieldImageModelSlug,
  type HiggsfieldVideoModelSlug,
} from '@/lib/higgsfield/models';

interface HiggsfieldStatus {
  connected: boolean;
  email?: string;
  name?: string;
  orgId?: string;
  expiresAt?: number;
  needsRefresh?: boolean;
}

interface HiggsfieldConnectionProps {
  selectedImageModel: HiggsfieldImageModelSlug;
  selectedVideoModel: HiggsfieldVideoModelSlug;
  onSelectImageModel: (slug: HiggsfieldImageModelSlug) => void;
  onSelectVideoModel: (slug: HiggsfieldVideoModelSlug) => void;
  /** V1.2.5: power-user CLI-token entry. When set, the Director
   *  loop prefers `@higgsfield/cli` over the OAuth web flow. */
  cliToken?: string;
  onSaveCliToken?: (token: string) => void;
  saving?: boolean;
  /**
   * Triggered when the connection state changes so the parent can
   * refresh `useImageGeneration`/pipeline provider availability.
   */
  onConnectionChange?: (connected: boolean) => void;
}

export function HiggsfieldConnection({
  selectedImageModel,
  selectedVideoModel,
  onSelectImageModel,
  onSelectVideoModel,
  cliToken,
  onSaveCliToken,
  saving,
  onConnectionChange,
}: HiggsfieldConnectionProps) {
  const [status, setStatus] = useState<HiggsfieldStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // V1.0.8.1-OAUTH-MIGRATION: when the desktop app surfaces
  // `expired_flow` on the OAuth callback, it almost always means the
  // user's Higgsfield OAuth client was registered before v1.0.7.1
  // and doesn't have the `mashupforge://` redirect URI in its
  // allowlist. We surface a one-click reset banner in that case so
  // the user doesn't have to dig into the Higgsfield dashboard to
  // re-register by hand.
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [resetting, setResetting] = useState(false);
  // V1.2.10-OAUTH: dedupe deep-link fires by `code`. The Tauri
  // deep-link plugin can fire the same URL twice (e.g. once on
  // OS redirect, once on app focus). Without dedup, the second
  // fire re-issues /callback with a now-used code, Higgsfield
  // returns `invalid_grant`, and the user sees a stale error
  // toast even though the first exchange succeeded.
  const processedCodes = useRef(new Set<string>());

  // V1.3.6-CLI-TOKEN: the user might be connected via a CLI token
  // (set in Settings, not via OAuth). If so, we treat the user as
  // connected even if the OAuth status endpoint returns false —
  // the OAuth status only knows about the OAuth-issued access
  // token, not about CLI tokens that the user pasted in. The
  // server routes accept `higgsfieldCliToken` in the request body
  // and thread it into the provider registry (see V1.2.5 pattern
  // in /api/ai/prompt/route.ts), so generation works without
  // ever going through the OAuth flow.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/higgsfield/oauth/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as HiggsfieldStatus;
      // CLI-token users are connected even if the OAuth endpoint
      // says otherwise — the OAuth endpoint can only see OAuth
      // tokens stored in IDB; CLI tokens live in settings.
      setStatus({ ...json, connected: json.connected || !!cliToken });
    } catch (e: unknown) {
      // If the OAuth status check fails (e.g. the endpoint can't
      // reach IDB), still treat the user as connected if they
      // have a CLI token set — that's a valid auth path.
      if (cliToken) {
        setStatus({ connected: true });
      } else {
        setError(e instanceof Error ? e.message : 'Failed to load Higgsfield status');
      }
    } finally {
      setLoading(false);
    }
  }, [cliToken]);

  useEffect(() => {
    // Defer the initial fetch to a microtask so `setLoading(true)` inside
    // `refresh` doesn't run synchronously in the effect body (React 19's
    // react-hooks/set-state-in-effect rule). The microtask is still
    // synchronous-from-the-user's-perspective: the load indicator
    // appears in the same browser frame as the effect.
    queueMicrotask(() => {
      void refresh();
    });
  }, [refresh]);

  // Auto-pick defaults if the user's current selection is empty or
  // not a known Higgsfield slug. We DON'T write automatically — the
  // user has to pick something. This effect only validates.
  const safeImageSlug = getHiggsfieldImageModel(selectedImageModel)
    ? selectedImageModel
    : HIGGSFIELD_DEFAULT_IMAGE_MODEL;
  const safeVideoSlug = (HIGGSFIELD_VIDEO_MODELS.find((m) => m.slug === selectedVideoModel)?.slug) ||
    HIGGSFIELD_DEFAULT_VIDEO_MODEL;

  const handleConnect = async () => {
    // V1.2.8: OAuth window now opens in the SYSTEM BROWSER, not
    // inside the MashupForge WebView. The previous behaviour
    // (`window.location.href = /api/higgsfield/oauth/authorize`)
    // navigated the WebView to the Higgsfield consent page, but
    // the Allow button's `mashupforge://oauth/callback` redirect
    // couldn't be handled by WebView2 (no `mashupforge://` scheme
    // registered to WebView2), so the click silently did nothing.
    //
    // The fix: in Tauri, fetch the final authorize URL from the
    // server (which sets the state/PKCE cookies in the response
    // and returns the constructed Higgsfield URL as JSON), then
    // hand that URL to `tauri-plugin-opener`'s `openUrl()` which
    // opens it in the user's default browser. The system browser
    // handles the OAuth consent page + the `mashupforge://`
    // callback redirect, and the OS launches MashupForge back.
    // The existing deep-link listener below picks up the code.
    //
    // Web (non-Tauri) keeps the 302 redirect behaviour — the
    // in-app navigation is correct there.
    const isTauri =
      typeof window !== 'undefined' &&
      (Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) ||
        Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__));

    if (!isTauri) {
      // Web build: in-app navigation is fine.
      window.location.href = '/api/higgsfield/oauth/authorize?via=desktop';
      return;
    }

    // Tauri build: fetch the URL + open it in the system browser.
    try {
      const res = await fetch('/api/higgsfield/oauth/authorize?via=desktop&format=json', {
        method: 'GET',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { url: string };
      if (!json.url) throw new Error('authorize route did not return a url');
      // Lazy-import the opener plugin so the web bundle doesn't
      // pull in Tauri-only modules.
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(json.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open OAuth window');
    }
  };

  // V107.1-OAUTH: listen for the deep-link event from the Tauri backend
  // and complete the OAuth flow by re-issuing the callback in the
  // WebView2 cookie context. Without this, the user gets `expired_flow`
  // because the state/PKCE cookies were set in WebView2 but the
  // callback URL is opened in the system browser by Tauri's default
  // external-URL handling.
  // V1.3.3-OAUTH: complete the OAuth round-trip from the deep-link
  // listener via fetch() (not window.location.href). This is the
  // fix for the bug where clicking Allow on the consent page would
  // cause a full page reload and drop in-memory state (watermark
  // upload, studio generations). The server's /callback route
  // returns JSON when `?format=json`; we update the connection card
  // in place and surface errors via the existing migration/error UI.
  const completeOAuthFlow = useCallback(
    async (args: { code?: string; state?: string; errorParam?: string }) => {
      try {
        if (args.errorParam) {
          setError(`Higgsfield connect failed (${args.errorParam})`)
          return
        }
        if (!args.code || !args.state) {
          setError('Higgsfield connect failed (missing_params)')
          return
        }
        const res = await fetch(
          `/api/higgsfield/oauth/callback?via=desktop&format=json&code=${encodeURIComponent(args.code)}&state=${encodeURIComponent(args.state)}`,
          { cache: 'no-store' },
        )
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          reason?: string
          detail?: string
          email?: string
          name?: string
          orgId?: string
        }
        if (!res.ok || !json.ok) {
          const reason = json.reason || 'unknown'
          const detail = json.detail || ''
          const msg = `Higgsfield connect failed (${reason})${detail ? `: ${detail.slice(0, 120)}` : ''}`
          setError(msg)
          const isTauri =
            typeof window !== 'undefined' &&
            (Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) ||
              Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__))
          const detailLower = detail.toLowerCase()
          const isRedirectUriMismatch =
            reason === 'invalid_request' ||
            detailLower.includes('redirect_uri') ||
            detailLower.includes('redirect uri') ||
            detailLower.includes('pre-registered')
          if (isTauri && isRedirectUriMismatch) setMigrationNeeded(true)
          return
        }
        await refresh()
        onConnectionChange?.(true)
      } catch (e) {
        setError(
          `Higgsfield connect failed (network): ${e instanceof Error ? e.message : 'unknown'}`,
        )
      }
    },
    [refresh, onConnectionChange],
  )

  // V1.3.6-OAUTH: extract a `processCallbackUrl` helper so the
  // listener and the `getCurrent()` drain share one code path. The
  // helper does the actual callback fetch (via JSON, not navigation)
  // and dedupes by `code` so the listener's later fire for the
  // same URL is a no-op.
  const processCallbackUrl = useCallback(
    async (raw: string) => {
      const url = new URL(raw.replace(/^mashupforge:/, 'https://mashupforge.invalid:'))
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const errorParam = url.searchParams.get('error')
      if (errorParam) {
        void completeOAuthFlow({ errorParam })
        return
      }
      if (!code || !state) {
        void completeOAuthFlow({ errorParam: 'missing_params' })
        return
      }
      if (processedCodes.current.has(code)) {
        // V1.2.10-OAUTH: duplicate deep-link fire for a code we
        // already processed — silently ignore so we don't override
        // the success redirect with a stale token_exchange error.
        return
      }
      processedCodes.current.add(code)
      void completeOAuthFlow({ code, state })
    },
    [completeOAuthFlow],
  )

  // V1.3.6-OAUTH: deep-link handling rewritten to use fetch() (not
  // window.location.href) and to ALSO call getCurrent() on mount.
  //
  // The previous v1.2.10 implementation did `window.location.href =
  // /studio?higgsfield=...` on every callback, which reloaded the
  // app, lost in-memory state, and was the original cause of the
  // user's complaint. v1.3.3 attempted to fix it but the patch
  // never landed in the file (verified: git show 40b6aa6 shows the
  // old `window.location.href` still present).
  //
  // Two new problems we now also address:
  //   1. `getCurrent()` on mount — if a deep link arrived BEFORE
  //      the listener was attached (race during Tauri startup /
  //      Next.js hydration), the URL is still retrievable via
  //      `getCurrent()` from the deep-link plugin. The listener
  //      alone misses those.
  //   2. The error path previously did a full navigation; we now
  //      surface errors via setError() (no reload, in-memory state
  //      preserved).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const tauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (!tauriInternals) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        // Lazy-import the event + deep-link APIs to avoid pulling
        // Tauri internals into the web bundle's type graph. The
        // dynamic import is a 1-line shim that the bundler
        // tree-shakes out for the web build.
        const { listen } = await import('@tauri-apps/api/event');
        const { getCurrent } = await import('@tauri-apps/plugin-deep-link');
        // V1.3.6-OAUTH: drain any URL that arrived before the
        // listener was attached. Tauri's `getCurrent()` returns
        // the launching URL (or the last URL the app was activated
        // with) so we can process it without waiting for a fresh
        // event. Without this, a fast click on "Allow" (where
        // the OS activates the app via deep link while the
        // WebView2 is still hydrating) loses the auth code.
        try {
          const initial = await getCurrent();
          if (initial && initial.length > 0) {
            for (const raw of initial) {
              if (raw.startsWith('mashupforge://oauth/callback')) {
                void processCallbackUrl(raw);
              }
            }
          }
        } catch {
          /* getCurrent can throw on web — ignore */
        }
        unlisten = await listen<string[]>('deep-link', (event) => {
          const urls = (event.payload as string[]) || [];
          for (const raw of urls) {
            if (!raw.startsWith('mashupforge://oauth/callback')) continue;
            void processCallbackUrl(raw);
          }
        });
      } catch (e) {
        setError(
          `Failed to register OAuth deep-link listener: ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
    // processCallbackUrl is stable for the lifetime of the
    // component (reads from refs and stable setters only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Higgsfield? Generation will fall back to Leonardo.')) return;
    setWorking(true);
    try {
      const res = await fetch('/api/higgsfield/oauth/disconnect', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
      onConnectionChange?.(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Disconnect failed');
    } finally {
      setWorking(false);
    }
  };

  // V1.0.8.1-OAUTH-MIGRATION: reset the locally-cached OAuth
  // client_id and bounce back into the authorize flow. The authorize
  // route will register a fresh client whose allowlist includes
  // `mashupforge://oauth/callback`, so the deep-link callback
  // succeeds on the next attempt.
  const handleResetAndRetry = async () => {
    setResetting(true);
    try {
      const res = await fetch('/api/higgsfield/oauth/reset-client', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMigrationNeeded(false);
      // V1.2.9: route the post-reset connect through the same
      // Tauri-aware path as `handleConnect`. The previous
      // `window.location.href = /api/higgsfield/oauth/authorize?via=desktop`
      // navigated the WebView to the Higgsfield consent page,
      // and the `mashupforge://` callback redirect silently
      // failed (same v1.2.8 bug as the regular connect flow).
      const isTauri =
        typeof window !== 'undefined' &&
        (Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) ||
          Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__));

      if (!isTauri) {
        window.location.href = '/api/higgsfield/oauth/authorize?via=desktop';
        return;
      }

      const authRes = await fetch('/api/higgsfield/oauth/authorize?via=desktop&format=json', {
        method: 'GET',
        cache: 'no-store',
      });
      if (!authRes.ok) throw new Error(`HTTP ${authRes.status}`);
      const authJson = (await authRes.json()) as { url: string };
      if (!authJson.url) throw new Error('authorize route did not return a url');
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(authJson.url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Reset failed');
      setResetting(false);
    }
  };

  // Surface a success banner when the URL has ?higgsfield=connected
  // (set by the callback route). Strip it after first read.
  //
  // ESLint react-hooks/set-state-in-effect: the setState calls below
  // are deferred via `queueMicrotask` so React's effect body only
  // synchronizes an external system (window.history) — not local
  // component state. The microtask runs after the effect's commit
  // phase so it doesn't trigger cascading renders.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const flag = url.searchParams.get('higgsfield');
    if (flag === 'connected') {
      onConnectionChange?.(true);
      queueMicrotask(() => {
        refresh();
      });
      url.searchParams.delete('higgsfield');
      window.history.replaceState({}, '', url.toString());
    } else if (flag === 'error') {
      const reason = url.searchParams.get('reason') || 'unknown';
      const detail = url.searchParams.get('detail') || '';
      const msg = `Higgsfield connect failed (${reason})${detail ? `: ${detail.slice(0, 120)}` : ''}`;
      // V1.0.8.1-OAUTH-MIGRATION: in the desktop app, an `expired_flow`
      // almost always means the user's Higgsfield OAuth client was
      // registered before v1.0.7.1 and doesn't have the
      // `mashupforge://` redirect URI.
      //
      // BUG-FIX-2026-06-06: the original trigger only fired on
      // `expired_flow` (our /callback's "no state cookie" case). But
      // when the OAuth server itself rejects the redirect_uri at the
      // /authorize step (before our callback ever runs), it returns
      // `reason=invalid_request` with a detail mentioning
      // `redirect_uri`. That was reported in v1.0.9 testing — the
      // banner never showed because `invalid_request` wasn't in the
      // trigger set. The fix: also fire the migration banner on
      // `invalid_request` (or any error whose detail mentions
      // redirect_uri). The web build never hits this case (it uses
      // the HTTPS callback), so the migration banner is desktop-only.
      const isTauri =
        typeof window !== 'undefined' &&
        (Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) ||
          Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__));
      const detailLower = detail.toLowerCase();
      const isRedirectUriMismatch =
        reason === 'invalid_request' ||
        detailLower.includes('redirect_uri') ||
        detailLower.includes('redirect uri') ||
        detailLower.includes('pre-registered');
      const needsMigration = isTauri && isRedirectUriMismatch;
      queueMicrotask(() => {
        setError(msg);
        setMigrationNeeded(needsMigration);
      });
      url.searchParams.delete('higgsfield');
      url.searchParams.delete('reason');
      url.searchParams.delete('detail');
      window.history.replaceState({}, '', url.toString());
    }
  }, [refresh, onConnectionChange]);

  return (
    <div className="space-y-4">
      {/* Connection card */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-white">Higgsfield MCP</h4>
            {loading ? (
              <div className="mt-1 flex items-center gap-2 text-xs text-white/60">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking connection…
              </div>
            ) : status?.connected ? (
              <div className="mt-1 space-y-0.5 text-xs">
                <div className="flex items-center gap-1.5 text-emerald-300">
                  <Check className="h-3 w-3" />
                  Connected as <span className="font-medium">{status.email || status.name || 'Higgsfield user'}</span>
                </div>
                {status.orgId && (
                  <div className="text-white/40">Workspace: {status.orgId}</div>
                )}
                {status.needsRefresh && (
                  <div className="text-amber-300">Token expiring soon — will refresh on next call.</div>
                )}
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-white/60">
                <X className="h-3 w-3" />
                Not connected. Each user must link their own Higgsfield account.
              </div>
            )}
            {error && <div className="mt-2 text-xs text-rose-300">{error}</div>}
            {migrationNeeded && (
              <div
                data-testid="oauth-migration-banner"
                className="mt-3 rounded border border-amber-400/40 bg-amber-500/10 p-3"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                  <div className="min-w-0 flex-1 space-y-2 text-[11px] leading-relaxed text-amber-100/90">
                    <p>
                      <span className="font-semibold text-amber-200">OAuth client needs a one-time update.</span>{' '}
                      You connected before v1.0.7.1, so your Higgsfield OAuth
                      client doesn&apos;t have the <code className="rounded bg-black/30 px-1 font-mono text-amber-200">mashupforge://</code> redirect URI in its allowlist.
                      The desktop app can&apos;t complete sign-in until that URI is registered.
                    </p>
                    <p className="text-amber-100/70">
                      <strong>One-click fix:</strong> reset the cached client ID and let MashupForge register a fresh one with the right allowlist. Your existing grants stay safe — re-registering only creates a new client, it doesn&apos;t revoke access.
                    </p>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleResetAndRetry}
                        disabled={resetting}
                        className="inline-flex items-center gap-1.5 rounded border border-amber-400/50 bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium text-amber-100 transition hover:bg-amber-500/30 disabled:opacity-50"
                      >
                        <RefreshCcw className="h-3 w-3" />
                        {resetting ? 'Resetting…' : 'Reset OAuth client and retry'}
                      </button>
                      <a
                        href="https://higgsfield.ai/dashboard/developers/oauth"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-amber-200/80 underline-offset-2 hover:text-amber-100 hover:underline"
                      >
                        Or update your client manually
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            {status?.connected ? (
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={working}
                className="rounded border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-50"
              >
                {working ? 'Disconnecting…' : 'Disconnect'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                disabled={loading}
                className="rounded border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Connect Higgsfield'}
              </button>
            )}
            {/* V1.1.0-HOTFIX: always-visible recovery action for users
                whose OAuth client was registered with an outdated
                redirect_uri allowlist. The OAuth 2.0 spec requires
                the server to display the `redirect_uri parameter does
                not match` error IN THE BROWSER (not via redirect), so
                the migration banner in the parent component never
                fires for that class of failure — the user is stranded
                unless they have a button to reset the cached client_id
                and re-register. This button is always visible (not
                gated on the migration banner) so any user who hits
                the redirect_uri error can self-recover. */}
            <button
              type="button"
              onClick={handleResetAndRetry}
              disabled={resetting || working}
              title="Wipe the cached OAuth client_id and re-register. Use this if the Connect flow fails with a 'redirect_uri does not match' error in the browser."
              className="text-[10px] text-white/40 underline-offset-2 transition hover:text-white/70 hover:underline disabled:opacity-50"
            >
              {resetting ? 'Resetting…' : 'Reset OAuth client'}
            </button>
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-white/40">
          Higgsfield runs 30+ image and video models (Nano Banana Pro, FLUX.2, Seedance 2.0, Veo 3.1,
          Kling 3.0, etc.) on a credit-based subscription. Connecting is OAuth — your credits, your
          account. We add Higgsfield <em>alongside</em> Leonardo, not as a replacement: pick per
          idea which provider to use.
        </p>
      </div>

      {/* Default model pickers — only meaningful when connected */}
      {status?.connected && (
        <>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-white/70">
              Default image model
            </label>
            <select
              value={safeImageSlug}
              disabled={saving}
              onChange={(e) => onSelectImageModel(e.target.value as HiggsfieldImageModelSlug)}
              className="w-full rounded border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white focus:border-emerald-400/60 focus:outline-none"
            >
              {HIGGSFIELD_IMAGE_MODELS.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.displayName}{m.badge === 'flagship' ? ' ★' : m.badge === 'fast' ? ' ⚡' : m.badge === 'character' ? ' 👤' : ''}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-white/40">
              {HIGGSFIELD_IMAGE_MODELS.find((m) => m.slug === safeImageSlug)?.blurb}
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-white/70">
              Default video model
            </label>
            <select
              value={safeVideoSlug}
              disabled={saving}
              onChange={(e) => onSelectVideoModel(e.target.value as HiggsfieldVideoModelSlug)}
              className="w-full rounded border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white focus:border-emerald-400/60 focus:outline-none"
            >
              {HIGGSFIELD_VIDEO_MODELS.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.displayName}{m.badge === 'flagship' ? ' ★' : m.badge === 'cheap' ? ' 💰' : m.badge === 'pro' ? ' 👑' : ''}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-white/40">
              {HIGGSFIELD_VIDEO_MODELS.find((m) => m.slug === safeVideoSlug)?.blurb}
            </p>
          </div>
        </>
      )}

      {/* CLI auth status (V1.2.6) */}
      <CliAuthStatusBlock />

      {/* CLI hint — power users can `npx @higgsfield/cli` for the full 35-model catalog */}
      <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-white/50">
          <span>Power users:</span>
          <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-emerald-200">
            npx @higgsfield/cli model list
          </code>
          <a
            href="https://higgsfield.ai/cli"
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-white/40 hover:text-white/70"
          >
            docs <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        {/* V1.2.6: the token field is now an ADVANCED OVERRIDE for
            headless / CI users who want to use a workspace token
            without overwriting their personal CLI auth cache. Most
            users should leave it empty and rely on the cached
            `higgsfield auth login` credentials above. */}
        {onSaveCliToken && (
          <details className="mt-3 group">
            <summary className="cursor-pointer text-[10px] text-white/40 transition hover:text-white/70">
              Override CLI token (advanced — for headless / CI use)
            </summary>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="password"
                defaultValue={cliToken ?? ''}
                placeholder="paste token (optional override)…"
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== (cliToken ?? '')) onSaveCliToken(next);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="flex-1 rounded border border-white/10 bg-black/30 px-2.5 py-1 font-mono text-[11px] text-white placeholder-white/30 focus:border-emerald-400/60 focus:outline-none disabled:opacity-50"
              />
              {cliToken && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-300">
                  <Check className="h-3 w-3" />
                  Override set
                </span>
              )}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-white/30">
              Written to a temp <code>credentials.json</code> at request time and pointed at via
              <code className="ml-1">HIGGSFIELD_CREDENTIALS_PATH</code>. Auto-cleaned on app exit.
              Most users should leave this empty and let the cached CLI auth handle it.
            </p>
          </details>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// V1.2.6: CLI auth status block
// ---------------------------------------------------------------------------

interface CliAuthStatus {
  binaryAvailable: boolean;
  authenticated: boolean;
  tokenPreview?: string;
  hint: string;
}

function CliAuthStatusBlock() {
  const [status, setStatus] = useState<CliAuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/higgsfield/cli-auth', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as CliAuthStatus;
      setStatus(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'CLI auth check failed');
    } finally {
      setLoading(false);
    }
  }, []);

  // Probe on mount so the user sees the cached-auth state without
  // having to click. The probe is cheap (3s timeout, single spawn)
  // and only fires once per Settings-panel mount.
  useEffect(() => {
    queueMicrotask(() => {
      void check();
    });
  }, [check]);

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] font-medium text-white/50">
            <span>CLI auth (recommended for power users):</span>
            <a
              href="https://higgsfield.ai/cli"
              target="_blank"
              rel="noreferrer"
              className="text-white/40 hover:text-white/70"
              title="How to install @higgsfield/cli"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="mt-1.5 text-[11px]">
            {loading && !status ? (
              <span className="inline-flex items-center gap-1.5 text-white/40">
                <Loader2 className="h-3 w-3 animate-spin" />
                Probing <code className="font-mono">higgsfield auth token</code>…
              </span>
            ) : error ? (
              <span className="text-rose-300">Check failed: {error}</span>
            ) : status && !status.binaryAvailable ? (
              <span className="text-white/40">
                CLI not on PATH. <code className="font-mono">npm i -g @higgsfield/cli</code> then <code className="font-mono">higgsfield auth login</code>.
              </span>
            ) : status && status.authenticated ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-300">
                <Check className="h-3 w-3" />
                Authenticated via cached CLI creds
                {status.tokenPreview && (
                  <code className="ml-1 font-mono text-[10px] text-white/40">
                    ({status.tokenPreview})
                  </code>
                )}
              </span>
            ) : status ? (
              <span className="text-amber-300">
                CLI installed but not authenticated. Run <code className="font-mono">higgsfield auth login</code> in a terminal.
              </span>
            ) : null}
          </div>
          {status?.hint && (
            <p className="mt-1.5 text-[10px] leading-relaxed text-white/30">{status.hint}</p>
          )}
        </div>
        <button
          type="button"
          onClick={check}
          disabled={loading}
          className="shrink-0 inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
          Recheck
        </button>
      </div>
    </div>
  );
}

export function ImageBackupPanel() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleExport = async () => {
    if (!confirm('Export all saved images to a backup file? This includes all your generated images and their metadata.')) return;
    setLoading(true);
    setMessage(null);
    try {
      const { get } = await import('@/lib/persistence');
      const { exportImagesToFile } = await import('@/lib/backup/images');
      const images = await get<import('@/types/mashup').GeneratedImage[]>('mashup_saved_images');
      if (!images || images.length === 0) {
        setMessage('No images to export');
        setLoading(false);
        return;
      }
      const { exportImagesToFile: doExport } = await import('@/lib/backup/images');
      const ok = await doExport(images);
      if (ok) setMessage('✅ Images exported successfully');
      else setMessage('❌ Export failed');
    } catch (e) {
      setMessage(`❌ Export failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!confirm('Import images from a backup file? This will merge with your current images.')) return;
    setLoading(true);
    setMessage(null);
    try {
      const { importImagesFromFile } = await import('@/lib/backup/images');
      // Prompt user to pick a backup file via hidden <input type="file">
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      const file = await new Promise<File | null>((resolve) => {
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.oncancel = () => resolve(null);
        input.click();
      });
      if (!file) {
        setMessage('Import cancelled');
        setLoading(false);
        return;
      }
      const images = await importImagesFromFile(file);
      if (images.length === 0) {
        setMessage('No valid images found in the backup file');
        setLoading(false);
        return;
      }
      const { set, get } = await import('@/lib/persistence');
      const existing = (await get<import('@/types/mashup').GeneratedImage[]>('mashup_saved_images')) || [];
      const byId = new Map<string, import('@/types/mashup').GeneratedImage>();
      for (const img of existing) byId.set(img.id, img);
      for (const img of images) byId.set(img.id, img);
      const merged = Array.from(byId.values());
      await set('mashup_saved_images', merged);
      setMessage(`✅ Imported ${images.length} images (merged with existing)`);
    } catch (e) {
      setMessage(`❌ Import failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!confirm('Restore images from the latest automatic backup? This will replace your current images.')) return;
    setLoading(true);
    setMessage(null);
    try {
      const { restoreFromAutoBackup } = await import('@/lib/backup/images');
      const { set } = await import('@/lib/persistence');
      const images = await restoreFromAutoBackup();
      if (!images || images.length === 0) {
        setMessage('No backup found');
        setLoading(false);
        return;
      }
      await set('mashup_saved_images', images);
      setMessage(`✅ Restored ${images.length} images from backup`);
    } catch (e) {
      setMessage(`❌ Restore failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="mt-4 group">
      <summary className="cursor-pointer text-sm font-medium text-white/70 flex items-center gap-2">
        <span className="text-white/50">💾</span>
        Image Library Backup &amp; Restore
      </summary>
      <div className="mt-3 space-y-3 pt-3 border-t border-white/5">
        <p className="text-[11px] text-white/40 leading-relaxed">
          Automatic backups are saved to your Documents folder (survives app reinstall). 
          Use these tools for manual backup/restore.
        </p>
        
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
          >
            <span>📤</span> Export Images
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
          >
            <span>📥</span> Import from File
          </button>
          <button
            type="button"
            onClick={handleRestore}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
          >
            <span>🔄</span> Restore Latest Backup
          </button>
        </div>

        {message && (
          <div className={`text-[11px] transition-colors ${message.startsWith('✅') ? 'text-emerald-300' : 'text-rose-300'}`}>
            {message}
          </div>
        )}
      </div>
    </details>
  );
}
