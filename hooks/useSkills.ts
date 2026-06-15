'use client';

/**
 * 4NE-27 — Skills manager state hook.
 *
 * Reactive wrapper around the `@/lib/connectors` skills CRUD. A Skill is a
 * named, least-privilege bundle granting the agent a SUBSET of one connector's
 * tools (see `lib/connectors/types.ts`). The hook keeps a render-state copy of
 * the persisted `Skill[]` and re-reads from the lib after each mutation.
 *
 * Validation stays in the lib (`validateSkill`); the hook re-exports it so the
 * panel's add-form can validate before calling `save` without importing the
 * lib directly.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  listSkills,
  saveSkill,
  removeSkill,
  validateSkill,
  type Skill,
  type SkillValidationResult,
} from '@/lib/connectors';

export interface UseSkillsResult {
  /** The persisted skills, in stored order. */
  skills: Skill[];
  /** True until the first load resolves. */
  loading: boolean;
  /** Reload the persisted skills. */
  refresh: () => Promise<void>;
  /** Validate a (possibly partial) skill WITHOUT persisting. */
  validate: (partial: Partial<Skill>) => SkillValidationResult;
  /** Upsert a skill (validates first; throws on invalid) then reload. */
  save: (skill: Skill) => Promise<void>;
  /** Remove a skill by id then reload. */
  remove: (id: string) => Promise<void>;
}

export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const list = await listSkills();
    setSkills(list);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const validate = useCallback((partial: Partial<Skill>) => validateSkill(partial), []);

  const save = useCallback(
    async (skill: Skill) => {
      await saveSkill(skill);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeSkill(id);
      await refresh();
    },
    [refresh],
  );

  return { skills, loading, refresh, validate, save, remove };
}
