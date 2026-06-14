'use client';

import { useEffect, useRef, useState } from 'react';
// BUG-DEV-012: persistence goes through `@/lib/persistence` (tauri-plugin-
// store in production, idb-keyval fallback in dev/test). The IDB key name
// stays the same so the migration runner in persistence.ts can detect any
// pre-fix value and copy it forward on first launch.
import { get, set } from '@/lib/persistence'
import { usePersistentStore } from './usePersistentStore'
import { autoBackupImages } from '@/lib/backup/images'
import { hasEmbeddedPixels, isAssetUrl, slimImageRecord } from '@/lib/images/slim'
import { displayUrlAsync } from '@/lib/images/storage'
import { type GeneratedImage } from '../types/mashup'

// Normalize images on load: rewrite legacy tag spelling and reset any
// transient pipeline status that was persisted mid-flight (the work itself
// did not survive the reload, so the status would otherwise be stuck).
function normalizeOnLoad(img: GeneratedImage): GeneratedImage {
  const tags = img.tags?.map(t => t === 'Warhammer 40,000' ? 'Warhammer 40k' : t);
  const status = img.status === 'generating' || img.status === 'animating' ? 'ready' : img.status;
  return { ...img, tags, status };
}

// V1.4.5-DATALOSS-ROOTCAUSE: id-union merge, `patch` wins on collisions.
// Used by the load path to fold freshly-loaded store data UNDER any
// in-memory mutations that happened before hydration finished (e.g. a
// Studio-generated image saved before the user ever visited Gallery).
function mergeById(base: GeneratedImage[], patch: GeneratedImage[]): GeneratedImage[] {
  const byId = new Map<string, GeneratedImage>();
  for (const img of base) byId.set(img.id, img);
  for (const img of patch) byId.set(img.id, img);
  return Array.from(byId.values());
}

export function useImages() {
  // v1.8.1 (followup #2b): the V1.4.5 wipe-safe gating — lazy load,
  // dirty/loadInFlight/hydratedOnce gates, the 200ms-debounced gated store
  // write, and the beforeunload crash-recovery flush — now lives ONCE in
  // usePersistentStore. useImages keeps its IMAGE-SPECIFIC machinery as
  // bespoke effects layered on top of the store: the localStorage
  // merge-promote load (via the `hydrate` callback), the M3.2 store-slimming
  // + once-per-session backlog migration, and the asset-URL refresh — all
  // consuming store.markDirty / store.valueRef / store.hydratedOnceRef.
  // hydrationFailedRef is subsumed by the store's hydratedOnceRef (a thrown
  // load leaves it false → the persist gate stays shut).

  // Bespoke refs (M3.2 disk-offload — NOT a generic store concern).
  const slimInFlightRef = useRef<Set<string>>(new Set());
  const migrationRanRef = useRef(false);
  // Reactive "hydration SUCCEEDED" flag (set via the store's onHydrated). The
  // bespoke migration effect gates on this STATE rather than reading the
  // store's hydratedOnceRef during render (which the React Compiler flags).
  const [hydratedOk, setHydratedOk] = useState(false);
  // While the backlog migration runs, the 200ms-debounced store write is
  // suppressed (wired to the store's shouldSkipWrite): each interim write
  // would JSON.stringify the still-mostly-fat array (seconds at 200 MB).
  const migratingRef = useRef(false);

  const store = usePersistentStore<GeneratedImage[]>({
    key: 'mashup_saved_images',
    initial: [],
    debounceMs: 200, // PROP-020: coalesce rapid mutations into one write.
    // V1.2.8 + V1.4.5: localStorage is a crash-recovery PATCH for in-flight
    // changes; the store is authoritative for the full library. ALWAYS read
    // the store, fold localStorage on top, write the consolidated result
    // BACK to the store, drop localStorage, then commit the merged value
    // UNDER any in-memory mutation (mergeById, in-memory wins). A thrown
    // store read PROPAGATES (we never swallow it) so the store leaves
    // hydratedOnceRef false and the persist gate stays shut — the
    // V1.4.5-HYDRATION-FAIL latch.
    hydrate: async (commit) => {
      const storedImages = localStorage.getItem('mashup_saved_images');
      if (storedImages) {
        try {
          const images = JSON.parse(storedImages).map(normalizeOnLoad);
          // V1.2.8: ALWAYS load from the store first (full data), merge
          // localStorage on top (the in-flight patch).
          const idbImages = await get('mashup_saved_images');
          if (images.length === 0) {
            // V1.2.5 bug artifact — empty array from a beforeunload that
            // fired before the user visited Gallery. Clear and use the store.
            localStorage.removeItem('mashup_saved_images');
            if (idbImages) commit(prev => mergeById(idbImages.map(normalizeOnLoad), prev));
          } else {
            const storeValue = Array.isArray(idbImages) ? idbImages : [];
            const merged = mergeById(storeValue, images);
            await set('mashup_saved_images', merged);
            localStorage.removeItem('mashup_saved_images');
            // V1.4.5: fold the merged result UNDER any in-memory mutation
            // made while the load was in flight.
            commit(prev => mergeById(merged, prev));
          }
        } catch {
          // JSON.parse (or the store read) failed — fall back to store-only.
          const idbImages = await get('mashup_saved_images');
          if (idbImages) commit(prev => mergeById(idbImages.map(normalizeOnLoad), prev));
        }
      } else {
        const idbImages = await get('mashup_saved_images');
        if (idbImages) commit(prev => mergeById(idbImages.map(normalizeOnLoad), prev));
      }
    },
    // Reactive success signal for the bespoke migration effect below.
    onHydrated: () => setHydratedOk(true),
    // M3.2: no store writes mid-migration (each would serialize the fat array).
    shouldSkipWrite: () => migratingRef.current,
    // Auto-backup to the Documents folder (survives reinstall), after each write.
    afterWrite: (imgs) => { void autoBackupImages(imgs); },
    // BUG-DES-002 / V1.4.4: beforeunload safety net for the 200ms window,
    // registered UNCONDITIONALLY with the empty-array short-circuit — the
    // v1.2.5 protection (never write `[]` to localStorage, since the next
    // load would merge it over the store and wipe the library).
    mirror: {
      writeSync: (imgs) => {
        try {
          localStorage.setItem('mashup_saved_images', JSON.stringify(imgs));
        } catch { /* storage quota — silent */ }
      },
      shouldFlush: (imgs) => imgs.length > 0,
    },
  });

  // Aliases so the bespoke effects + mutators below read exactly as before.
  const savedImages = store.value;
  const setSavedImages = store.setValue;
  const markDirty = store.markDirty;
  const isImagesLoaded = store.isLoaded;
  // LOCAL commit-phase mirror (not store.valueRef) so the bespoke migration /
  // asset-refresh effects read a local ref — reading the store's valueRef in
  // those effects trips the React-Compiler refs rule. Synced after commit.
  const savedImagesRef = useRef(savedImages);
  useEffect(() => {
    savedImagesRef.current = savedImages;
  }, [savedImages]);

  // ── M3.2 (V1.8): store slimming — embedded pixels OUT of the JSON ──
  // The watermark flows write canvas data-URLs (~0.5 MB each) into `url`;
  // every save kicks an async slim pass: pixels go to the canonical images
  // dir (v1.4.4 file-per-image), the record keeps a `localPath` reference.
  // Off-Tauri slimImageRecord returns null and the fat record stays — the
  // predicate still matches next launch, so nothing is lost.
  const slimAndPatch = async (img: GeneratedImage): Promise<boolean> => {
    if (slimInFlightRef.current.has(img.id)) return false;
    slimInFlightRef.current.add(img.id);
    try {
      const slim = await slimImageRecord(img);
      if (!slim) return false;
      markDirty();
      setSavedImages(prev => prev.map(i =>
        i.id === img.id
          ? { ...i, localPath: slim.localPath, url: slim.url, base64: undefined }
          : i,
      ));
      return true;
    } catch {
      return false;
    } finally {
      slimInFlightRef.current.delete(img.id);
    }
  };

  // One-time-per-session background migration for records persisted fat by
  // older versions, then an asset-URL refresh. Runs after a SUCCESSFUL
  // hydration (store.hydratedOnceRef) — a failed load leaves it false and
  // this is skipped. Idempotent: slimmed records no longer match the
  // predicate; a failed write leaves the fat record for the next launch.
  useEffect(() => {
    if (!hydratedOk) return; // reactive: only after a SUCCESSFUL hydration
    if (migrationRanRef.current) return;
    migrationRanRef.current = true;
    let cancelled = false;
    void (async () => {
      const fat = savedImagesRef.current.filter(hasEmbeddedPixels);
      if (fat.length > 0) migratingRef.current = true;
      for (const img of fat) {
        if (cancelled) { migratingRef.current = false; return; }
        await slimAndPatch(img);
        // Yield between writes — keeps the main thread responsive while the
        // first post-update launch migrates the backlog.
        await new Promise((r) => setTimeout(r, 50));
      }
      migratingRef.current = false;
      if (fat.length > 0 && !cancelled) {
        // Re-arm the debounce so the final slim state persists now.
        markDirty();
        setSavedImages(prev => [...prev]);
      }
      // Refresh stale asset URLs: the persisted `url` of a slimmed record
      // embeds an ABSOLUTE path (convertFileSrc) that goes stale when the
      // app-data folder moves / the app is reinstalled. localPath is the
      // durable reference — re-derive. Cheap; off-Tauri displayUrlAsync just
      // echoes the stored url → no patch.
      const withLocal = savedImagesRef.current.filter(
        (i) => i.localPath && (!i.url || isAssetUrl(i.url)),
      );
      for (const img of withLocal) {
        if (cancelled) return;
        try {
          const fresh = await displayUrlAsync(img);
          if (fresh && fresh !== img.url) {
            markDirty();
            setSavedImages(prev => prev.map(i =>
              i.id === img.id ? { ...i, url: fresh } : i,
            ));
          }
        } catch { /* keep the stored url */ }
      }
    })();
    return () => { cancelled = true; };
    // slimAndPatch is stable-in-practice (uses refs + setState); the effect
    // must fire exactly once per successful hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydratedOk]);

  const saveImage = (img: GeneratedImage) => {
    markDirty();
    setSavedImages(prev => {
      const exists = prev.some(i => i.id === img.id);
      if (exists) return prev.map(i => i.id === img.id ? { ...i, ...img } : i);
      return [{ ...img, savedAt: Date.now() }, ...prev];
    });
    // Fire-and-forget: pixels to disk, reference in the store. Saved fat
    // first (UI stays snappy, nothing lost on crash), patched slim when the
    // disk write lands.
    if (hasEmbeddedPixels(img)) void slimAndPatch(img);
  };

  const deleteImage = (id: string, fromSaved: boolean) => {
    if (fromSaved) {
      markDirty();
      setSavedImages(prev => prev.filter(i => i.id !== id));
    }
    return !fromSaved;
  };

  // Bulk-remove saved-image metadata in a SINGLE store write (one markDirty +
  // one setValue), so cleaning up a few hundred zombie records doesn't fire a
  // few hundred debounced persists + auto-backups. Metadata-only: the gallery
  // reconciler only ever passes ids whose pixels are already gone (no on-disk
  // file to delete). See lib/images/reconcile.ts.
  const removeImages = (ids: ReadonlySet<string>) => {
    if (ids.size === 0) return;
    markDirty();
    setSavedImages(prev => prev.filter(i => !ids.has(i.id)));
  };

  const updateImageTags = (id: string, tags: string[]) => {
    markDirty();
    setSavedImages(prev => prev.map(img => img.id === id ? { ...img, tags } : img));
  };

  const bulkUpdateImageTags = (ids: string[], tags: string[], mode: 'append' | 'replace') => {
    markDirty();
    setSavedImages(prev => prev.map(img => {
      if (!ids.includes(img.id)) return img;
      if (mode === 'append') {
        const existingTags = img.tags || [];
        return { ...img, tags: Array.from(new Set([...existingTags, ...tags])) };
      }
      return { ...img, tags };
    }));
  };

  const toggleApproveImage = (id: string) => {
    markDirty();
    setSavedImages(prev => prev.map(img => img.id === id ? { ...img, approved: !img.approved } : img));
  };

  const setImageStatus = (id: string, status: 'generating' | 'animating' | 'ready') => {
    markDirty();
    setSavedImages(prev => prev.map(img => img.id === id ? { ...img, status } : img));
  };

  const updateSavedImageCollectionId = (imageId: string, collectionId: string | undefined) => {
    markDirty();
    setSavedImages(prev => prev.map(img => img.id === imageId ? { ...img, collectionId } : img));
  };

  const clearCollectionFromImages = (collectionId: string) => {
    markDirty();
    setSavedImages(prev => prev.map(img => img.collectionId === collectionId ? { ...img, collectionId: undefined } : img));
  };

  return {
    savedImages,
    saveImage,
    deleteImage,
    removeImages,
    updateImageTags,
    bulkUpdateImageTags,
    toggleApproveImage,
    setImageStatus,
    updateSavedImageCollectionId,
    clearCollectionFromImages,
    isImagesLoaded,
    // V1.2.1: trigger the actual persistence load. Called by the Gallery
    // view on mount. Studio mount no longer blocks on this.
    requestLoad: store.requestLoad,
  };
}
