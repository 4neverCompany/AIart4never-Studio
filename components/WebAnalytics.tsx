'use client';

/**
 * Vercel Web Analytics — WEB BUILD ONLY (Maurice, 2026-06-11: wanted
 * for future performance analysis).
 *
 * The shared root layout renders in both the Vercel web build and the
 * Tauri desktop build. On desktop, @vercel/analytics would inject a
 * <script src="/_vercel/insights/script.js"> that 404s against the
 * local sidecar on every launch and then retries beacons into the
 * void — pure console noise and pointless requests for zero data
 * (Vercel only accepts events from its own production domains). So we
 * gate on the Tauri marker and render nothing on desktop.
 *
 * The marker check runs client-side; during SSR we render null too
 * (Analytics is a client beacon — there is nothing to server-render).
 */

import { useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/next';

export function WebAnalytics() {
  const [isWeb, setIsWeb] = useState(false);

  // Defer the setState via queueMicrotask (project convention for the
  // react-hooks/set-state-in-effect rule), stale-guarded against
  // unmount before the microtask fires. The two-step mount dance is
  // deliberate: rendering <Analytics /> from a useState initializer
  // would mismatch the server-rendered null during hydration.
  useEffect(() => {
    let stale = false;
    const isTauri =
      typeof window !== 'undefined'
      && '__TAURI_INTERNALS__' in window;
    queueMicrotask(() => {
      if (!stale) setIsWeb(!isTauri);
    });
    return () => { stale = true; };
  }, []);

  if (!isWeb) return null;
  return <Analytics />;
}
