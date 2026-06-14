'use client';

import { usePersistentStore } from './usePersistentStore';
import { type Idea } from '../types/mashup';

// V1.4.7: id-union merge, `patch` (in-memory) wins on collisions — the load
// path folds store data UNDER mutations made before hydration. (Known,
// deliberate quirk: a delete BEFORE hydration is undone by patch-wins —
// the stored idea reappears. Existing behavior; not "fixed" here.)
function mergeIdeasById(loaded: Idea[] | null, prev: Idea[]): Idea[] {
  const byId = new Map<string, Idea>();
  for (const idea of loaded ?? []) byId.set(idea.id, idea);
  for (const idea of prev) byId.set(idea.id, idea);
  return Array.from(byId.values());
}

/**
 * Ideas store. v1.8.1: the hand-rolled dirty/loadInFlight/lazy-load gating
 * (the V1.4.7 wipe-safety machinery) now lives in usePersistentStore — this
 * hook is just the idea-shaped mutators over it. Behavior is unchanged:
 * store-primary, immediate (non-debounced) gated write, mergeIdeasById
 * patch-wins on load, no localStorage mirror / beforeunload flush.
 */
export function useIdeas() {
  const store = usePersistentStore<Idea[]>({
    key: 'mashup_ideas',
    initial: [],
    merge: mergeIdeasById,
    // debounceMs defaults to 0 → synchronous in-effect write, matching the
    // pre-extraction useIdeas persist effect.
  });

  const addIdea = (concept: string, context?: string) => {
    const newIdea: Idea = {
      id: `idea-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      concept,
      context,
      createdAt: Date.now(),
      status: 'idea',
    };
    store.mutate(prev => [newIdea, ...prev]);
  };

  const updateIdeaStatus = (id: string, status: 'idea' | 'in-work' | 'done') => {
    store.mutate(prev => prev.map(idea => idea.id === id ? { ...idea, status } : idea));
  };

  const deleteIdea = (id: string) => {
    store.mutate(prev => prev.filter(idea => idea.id !== id));
  };

  const clearIdeas = () => {
    store.mutate([]);
  };

  return {
    ideas: store.value,
    addIdea,
    clearIdeas,
    updateIdeaStatus,
    deleteIdea,
    isIdeasLoaded: store.isLoaded,
    requestLoad: store.requestLoad,
  };
}
