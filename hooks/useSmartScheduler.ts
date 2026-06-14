'use client';

import { useState, useCallback } from 'react';
import {
  findBestSlots,
  fetchInstagramEngagement,
  loadEngagementData,
  type SlotScore,
} from '@/lib/smartScheduler';
import type { PostPlatform, ScheduledPost } from '@/types/mashup';

export interface SmartSchedulerForm {
  date: string;
  time: string;
  platforms: PostPlatform[];
}

export interface UseSmartSchedulerOptions {
  /** Number of posts to schedule. Determines how many slots to fetch. */
  postCount: number;
  /** Existing scheduled posts (used to avoid time collisions). */
  scheduledPosts: ScheduledPost[];
  /** Pre-selected platforms to seed the form. */
  defaultPlatforms: PostPlatform[];
  /** Instagram access token for live engagement data (optional). */
  igAccessToken?: string;
  /** Instagram account ID for live engagement data (optional). */
  igAccountId?: string;
}

export interface UseSmartSchedulerReturn {
  slots: SlotScore[];
  loading: boolean;
  source: string;
  form: SmartSchedulerForm;
  setForm: React.Dispatch<React.SetStateAction<SmartSchedulerForm>>;
  /** Fetch engagement data and compute optimal slots.
   *  Pass countOverride when post count is only known at call time. */
  trigger: (countOverride?: number) => Promise<void>;
  /** Clear slot results (call after modal close). */
  clear: () => void;
}

const EMPTY_FORM: SmartSchedulerForm = { date: '', time: '', platforms: [] };

export function useSmartScheduler({
  postCount,
  scheduledPosts,
  defaultPlatforms,
  igAccessToken,
  igAccountId,
}: UseSmartSchedulerOptions): UseSmartSchedulerReturn {
  const [slots, setSlots] = useState<SlotScore[]>([]);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState('');
  const [form, setForm] = useState<SmartSchedulerForm>(EMPTY_FORM);

  /** Fetch engagement data and compute optimal slots.
   *  `countOverride` lets callers pass the real post count when it is
   *  only known at call time (e.g. computed inside a render IIFE). */
  const trigger = useCallback(async (countOverride?: number) => {
    const count = countOverride ?? postCount;
    setLoading(true);
    setSlots([]);

    const computeSlots = (eng: Awaited<ReturnType<typeof fetchInstagramEngagement>>) => {
      // AUTO-SCHEDULE-FIX (2026-05-21): derive a per-day cap so the
      // modal spreads picks across days instead of stacking every slot
      // on the dominant engagement day. ceil(count / 14) targets roughly
      // even fill over the 14-day horizon: 5 posts → 1/day → spreads
      // over 5+ days; 20 posts → 2/day; 50 posts → 4/day.
      //
      // AUTO-SCHEDULE-DEPTH-FIRST (2026-05-22): depth-first fill so
      // multi-slot picks fill each day's heatmap-ordered hours before
      // moving on, instead of clustering at the dominant hour across
      // days. Matches Maurice's expected behaviour for the modal.
      const postsPerDay = Math.max(1, Math.ceil(count / 14));
      const newSlots = findBestSlots(scheduledPosts, count, eng, { postsPerDay, fillMode: 'depth' });
      setSlots(newSlots);
      if (newSlots.length > 0) {
        setForm({ date: newSlots[0].date, time: newSlots[0].time, platforms: defaultPlatforms });
      }
    };

    try {
      const eng = await fetchInstagramEngagement(igAccessToken, igAccountId);
      setSource(eng.source === 'instagram' ? 'IG insights' : 'Research defaults');
      computeSlots(eng);
    } catch {
      const eng = loadEngagementData();
      setSource('Research defaults');
      computeSlots(eng);
    } finally {
      setLoading(false);
    }
  }, [postCount, scheduledPosts, defaultPlatforms, igAccessToken, igAccountId]);

  const clear = useCallback(() => {
    setSlots([]);
    setSource('');
    setForm(EMPTY_FORM);
  }, []);

  return { slots, loading, source, form, setForm, trigger, clear };
}
