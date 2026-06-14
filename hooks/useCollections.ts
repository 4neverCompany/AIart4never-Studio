'use client';

import { useState, useEffect } from 'react';
// BUG-DEV-012: persisted through `@/lib/persistence` so collections survive
// a folder move on Windows (WebView2 IndexedDB partitioning fix).
import { get, set } from '@/lib/persistence';
import { type Collection, type GeneratedImage, type UserSettings } from '../types/mashup';
import { streamAIToString } from '@/lib/aiClient';

export function useCollections(settings: UserSettings) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isCollectionsLoaded, setIsCollectionsLoaded] = useState(false);
  // V1.2.1: lazy load — see useImages.ts for the full rationale.
  // The Tauri plugin-store eagerly loads the whole mashupforge.json,
  // which can be 100+ MB for users with many saved images/comparisons.
  // Studio mount doesn't need collections, so defer the load to the
  // Collections view via `requestLoad()`.
  const [loadTriggered, setLoadTriggered] = useState(false);

  useEffect(() => {
    if (!loadTriggered) {
      // react-hooks/set-state-in-effect: deferred via queueMicrotask
      // (project convention), stale-guarded against a loadTriggered
      // flip before the microtask fires.
      let stale = false;
      queueMicrotask(() => {
        if (!stale) setIsCollectionsLoaded(true);
      });
      return () => { stale = true; };
    }
    let cancelled = false;
    const loadCollections = async () => {
      try {
        const storedCollections = localStorage.getItem('mashup_collections');
        if (storedCollections) {
          // V1.2.6-HOTFIX + V1.2.8: same merge-with-store pattern
          // as useImages. localStorage is a patch, the store is
          // authoritative.
          const parsed = JSON.parse(storedCollections);
          if (Array.isArray(parsed) && parsed.length === 0) {
            // V1.2.5 bug artifact — empty array from a write
            // that shouldn't have happened. Clear and fall
            // through to the store.
            localStorage.removeItem('mashup_collections');
            const idbCollections = await get('mashup_collections');
            if (idbCollections && !cancelled) setCollections(idbCollections);
          } else {
            // Merge: store first, localStorage on top (by id).
            const idbCollections = await get('mashup_collections');
            const storeValue = Array.isArray(idbCollections) ? idbCollections : [];
            const byId = new Map<string, Collection>();
            for (const c of storeValue) byId.set(c.id, c);
            for (const c of (Array.isArray(parsed) ? parsed : [])) byId.set(c.id, c);
            const merged = Array.from(byId.values());
            await set('mashup_collections', merged);
            localStorage.removeItem('mashup_collections');
            if (!cancelled) setCollections(merged);
          }
        } else {
          const idbCollections = await get('mashup_collections');
          if (idbCollections && !cancelled) setCollections(idbCollections);
        }
      } catch {
        // silent — collections remain empty
      } finally {
        if (!cancelled) setIsCollectionsLoaded(true);
      }
    };
    loadCollections();
    return () => { cancelled = true; };
  }, [loadTriggered]);

  const autoGenerateCollectionInfo = async (
    sampleImages: GeneratedImage[] | string[],
  ): Promise<{ name: string; description: string } | null> => {
    try {
      let context = '';
      if (sampleImages.length > 0 && typeof sampleImages[0] === 'string') {
        context = (sampleImages as string[]).map((p, i) => `${i+1}. ${p}`).join('\n');
      } else {
        context = (sampleImages as GeneratedImage[]).map((img, i) => {
          const tags = img.postHashtags?.length ? ` | Tags: ${img.postHashtags.join(', ')}` : '';
          return `${i+1}. Prompt: ${img.prompt}, Model: ${img.modelInfo?.modelName || 'Unknown'}, Provider: ${img.modelInfo?.provider || 'Unknown'}${tags}`;
        }).join('\n');
      }

      const text = await streamAIToString(
        `Based on these sample images/prompt: "${context}"
Generate a creative collection name (short, catchy) and a brief description (1-2 sentences).
Return a JSON object with "name" and "description" keys.`,
        {
          mode: 'collection-info',
          systemPrompt: settings.agentPrompt,
          niches: settings.agentNiches,
          genres: settings.agentGenres,
          provider: settings.activeAiAgent,
          model: settings.activeTextModel,
        }
      );
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const data = JSON.parse(cleaned || '{}');
      if (!data.name && !data.description) return null;
      return {
        name: data.name || '',
        description: data.description || '',
      };
    } catch {
      // V080-DES-004 — return null so the Suggest button leaves fields
      // empty on failure (no silent default). createCollection fallback
      // still handles an empty name by assigning "Collection N".
      return null;
    }
  };

  const createCollection = async (
    name?: string,
    description?: string,
    imageIds?: string[],
    savedImages?: GeneratedImage[]
  ) => {
    let finalName = name;
    let finalDesc = description;

    if ((!finalName || !finalDesc) && imageIds && imageIds.length > 0 && savedImages) {
      const sampleImgs = savedImages
        .filter(img => imageIds.includes(img.id))
        .slice(0, 5);

      if (sampleImgs.length > 0) {
        const aiInfo = await autoGenerateCollectionInfo(sampleImgs);
        if (aiInfo) {
          if (!finalName) finalName = aiInfo.name;
          if (!finalDesc) finalDesc = aiInfo.description;
        }
      }
    }

    if (!finalName) {
      finalName = `Collection ${collections.length + 1}`;
    }

    const newCollection: Collection = {
      id: `col-${Date.now()}`,
      name: finalName,
      description: finalDesc,
      createdAt: Date.now()
    };
    setCollections(prev => {
      const next = [...prev, newCollection];
      localStorage.setItem('mashup_collections', JSON.stringify(next));
      return next;
    });
    return newCollection;
  };

  const deleteCollection = (id: string) => {
    setCollections(prev => {
      const next = prev.filter(c => c.id !== id);
      localStorage.setItem('mashup_collections', JSON.stringify(next));
      return next;
    });
  };

  return {
    collections,
    createCollection,
    deleteCollection,
    autoGenerateCollectionInfo,
    isCollectionsLoaded,
    requestLoad: () => setLoadTriggered(true),
  };
}

// V082-COLLECTION-FEATURES: pure helpers for tag-driven auto-grouping.
// Exported at module scope so tests can exercise the grouping logic
// without spinning up React state.

/**
 * Lowercase + trim a tag so matching is case-insensitive and robust to
 * stray whitespace. Returns '' for falsy input — callers should filter
 * empty keys before grouping.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** All distinct tags on an image — user tags + post hashtags. */
function imageTags(img: GeneratedImage): string[] {
  const user = (img.tags || []).map(normalizeTag);
  const hash = (img.postHashtags || []).map((t) => normalizeTag(t.replace(/^#/, '')));
  return Array.from(new Set([...user, ...hash].filter(Boolean)));
}

export interface TagGroupProposal {
  tag: string;
  displayName: string;
  imageIds: string[];
}

/**
 * Bucket savedImages by their tags. Each image lands in every bucket
 * for every tag it carries (so one image may seed multiple proposals).
 * Only buckets with >= minImages are surfaced as proposals. Buckets are
 * sorted largest-first so the UI can lead with the biggest groups.
 */
export function proposeTagGroups(
  savedImages: GeneratedImage[],
  minImages = 3,
): TagGroupProposal[] {
  const buckets = new Map<string, { display: string; ids: Set<string> }>();
  for (const img of savedImages) {
    const tags = imageTags(img);
    const displayByTag = new Map<string, string>();
    for (const raw of [...(img.tags || []), ...(img.postHashtags || [])]) {
      const norm = normalizeTag(raw.replace(/^#/, ''));
      if (!norm) continue;
      if (!displayByTag.has(norm)) displayByTag.set(norm, raw.replace(/^#/, '').trim());
    }
    for (const t of tags) {
      const entry = buckets.get(t) ?? {
        display: displayByTag.get(t) || t,
        ids: new Set<string>(),
      };
      entry.ids.add(img.id);
      buckets.set(t, entry);
    }
  }
  const proposals: TagGroupProposal[] = [];
  for (const [tag, { display, ids }] of buckets.entries()) {
    if (ids.size < minImages) continue;
    proposals.push({ tag, displayName: display, imageIds: Array.from(ids) });
  }
  proposals.sort((a, b) => b.imageIds.length - a.imageIds.length);
  return proposals;
}

/**
 * Find images in `pool` that share any tag with `collectionImages` and
 * are not already in the collection. Used by the "auto-add matching"
 * action on an existing collection so new Batman renders land next to
 * their siblings without the user dragging each one manually.
 */
export function findMatchingImages(
  pool: GeneratedImage[],
  collectionImages: GeneratedImage[],
  collectionId: string,
): GeneratedImage[] {
  const targetTags = new Set<string>();
  for (const img of collectionImages) for (const t of imageTags(img)) targetTags.add(t);
  if (targetTags.size === 0) return [];
  return pool.filter((img) => {
    if (img.collectionId === collectionId) return false;
    return imageTags(img).some((t) => targetTags.has(t));
  });
}
