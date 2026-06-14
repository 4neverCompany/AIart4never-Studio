'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeneratedImage } from '@/types/mashup';
import { findMissingImageIds } from '@/lib/images/reconcile';

/**
 * Gallery zombie reconciler (2026-06-14, task #51).
 *
 * Scans the saved-image store ONCE per session (desktop only, after images
 * have loaded) and reports which records are "missing" — pixels gone, per
 * lib/images/reconcile.ts (local file absent AND no base64; remote-only urls
 * don't count). It never deletes on its own: it exposes a count + a
 * `removeMissing()` the UI calls behind a user confirmation, which drops all
 * missing records in a single store write.
 *
 * This is what makes the gallery count honest again and shrinks the store /
 * auto-backup JSON that re-serializes on every mutation.
 */
export function useImageReconciler(
  savedImages: GeneratedImage[],
  isDesktop: boolean | null,
  removeImages: (ids: ReadonlySet<string>) => void,
) {
  const [missingIds, setMissingIds] = useState<Set<string>>(() => new Set());
  const [scanning, setScanning] = useState(false);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    if (isDesktop !== true) return;
    if (savedImages.length === 0) return;
    ranRef.current = true;
    let cancelled = false;
    // Defer the setState out of the effect body (React 19 /
    // react-hooks/set-state-in-effect convention); the scan itself is async.
    queueMicrotask(() => {
      if (cancelled) return;
      setScanning(true);
      void findMissingImageIds(savedImages)
        .then((missing) => {
          if (!cancelled) setMissingIds(missing);
        })
        .finally(() => {
          if (!cancelled) setScanning(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [isDesktop, savedImages]);

  const removeMissing = useCallback(() => {
    if (missingIds.size === 0) return;
    removeImages(missingIds);
    setMissingIds(new Set());
  }, [missingIds, removeImages]);

  return {
    /** How many saved records point at pixels that are gone. */
    missingCount: missingIds.size,
    missingIds,
    /** True while the one-shot disk scan is in flight. */
    scanning,
    /** Drop every missing record in a single store write. Caller confirms. */
    removeMissing,
  };
}
