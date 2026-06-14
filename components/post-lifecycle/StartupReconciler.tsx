/**
 * StartupReconciler — runs the post-lifecycle Reconciler once on mount,
 * surfaces the result via a toast or banner.
 *
 * Drop this in the root layout (or any persistent client component)
 * and the v0.9.41 regression gate is enforced at app startup.
 */

'use client';

import { useEffect, useRef } from 'react';
import { useReconciler } from '@/hooks/useReconciler';

export function StartupReconciler() {
  const { lastResult, running, error } = useReconciler();
  const toastShownRef = useRef(false);

  useEffect(() => {
    if (running || !lastResult) return;
    if (toastShownRef.current) return;

    toastShownRef.current = true;

    const { failed, recovered } = lastResult;
    if (failed.length === 0 && recovered.length === 0) return;

    // Surface to the user via console for now. A proper toast hook
    // would dispatch a notification here.
    // The RecoveryPanel component reads these results separately.
    if (failed.length > 0) {
      console.warn(
        `[StartupReconciler] ${failed.length} post(s) in 'failed' state — see Recovery panel.`,
      );
    }
    if (recovered.length > 0) {
      console.info(
        `[StartupReconciler] ${recovered.length} post(s) recovered.`,
      );
    }
  }, [running, lastResult]);

  useEffect(() => {
    if (error) {
      console.error('[StartupReconciler] reconcile failed:', error);
    }
  }, [error]);

  return null;
}
