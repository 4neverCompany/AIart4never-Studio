'use client';

import { useEffect, useState } from 'react';

/**
 * Returns whether the MMX CLI is callable on the server.
 *
 * - `null` while the GET is in flight (callers should treat as "unknown,
 *   render nothing yet" so disabled buttons don't flash on every load).
 * - `true` / `false` once /api/mmx/availability has answered.
 *
 * Cached in module scope so siblings (Sidebar + Studio) don't refetch.
 * Per-tab; a hard reload re-probes.
 */
let cachedAvailable: boolean | null = null;
let inflight: Promise<boolean> | null = null;

async function probe(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/mmx/availability', { cache: 'no-store' });
      if (!res.ok) {
        cachedAvailable = false;
        return false;
      }
      const data = (await res.json()) as { available?: boolean };
      cachedAvailable = !!data.available;
      return cachedAvailable;
    } catch {
      cachedAvailable = false;
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useMmxAvailability(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(cachedAvailable);

  useEffect(() => {
    let cancelled = false;
    probe().then((v) => {
      if (!cancelled) setAvailable(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}
