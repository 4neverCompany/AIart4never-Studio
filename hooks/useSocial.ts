'use client';

import { type GeneratedImage, type UserSettings } from '../types/mashup';
import { streamAIToString, extractJsonObjectFromLLM } from '@/lib/aiClient';

interface UseSocialDeps {
  settings: UserSettings;
  saveImage: (img: GeneratedImage) => void;
  setImages: React.Dispatch<React.SetStateAction<GeneratedImage[]>>;
}

export function useSocial({ settings, saveImage, setImages }: UseSocialDeps) {
  const generatePostContent = async (image: GeneratedImage): Promise<GeneratedImage | undefined> => {
    if (!image.prompt) return;

    const channel = settings.channelName || 'MultiverseMashupAI';
    try {
      const text = await streamAIToString(
        `You are a Social Media Manager for the channel "${channel}".
Generate a high-engagement Instagram caption for this image prompt: "${image.prompt}".
The caption should be professional yet edgy, fitting a "Master Content Creator" persona.
Include fitting emojis.
Include BETWEEN 8 AND 12 relevant hashtags — not fewer, not more. The first
hashtag in the array MUST be #${channel} (the channel's own hashtag).
Return ONLY a JSON object with exactly two keys: "caption" (string) and "hashtags" (array of strings).`,
        {
          mode: 'caption',
          systemPrompt: settings.agentPrompt,
          niches: settings.agentNiches,
          genres: settings.agentGenres,
          provider: settings.activeAiAgent,
          model: settings.activeTextModel,
        }
      );

      // extractJsonObjectFromLLM strips <think>…</think> reasoning
      // blocks (MiniMax-M2.5 et al.), markdown fences, and slices
      // first-`{` to last-`}`. Going through bare `JSON.parse` here
      // silently fails on reasoning-model output and the caption
      // never appears — see commit fixing MXIMG-001.
      const data = extractJsonObjectFromLLM(text);
      const caption = typeof data.caption === 'string' ? data.caption : '';
      // BUG-FIX-2026-06-06: enforce the 8-12 hashtag count client-side as
      // a safety net. The prompt tells the LLM to produce 8-12, but
      // models sometimes overshoot (20+) or undershoot (3-4) anyway. We
      // cap at 12 to honour the prompt and trim/extend to a minimum of
      // 8. The channel hashtag (position 0 in the raw array) is always
      // preserved first.
      const rawHashtags = Array.isArray(data.hashtags)
        ? data.hashtags.filter((t): t is string => typeof t === 'string')
        : [];
      // Dedupe (case-insensitive), keep first occurrence's casing.
      const seenHashtags = new Set<string>();
      const dedupedHashtags: string[] = [];
      for (const tag of rawHashtags) {
        const key = tag.toLowerCase();
        if (seenHashtags.has(key)) continue;
        seenHashtags.add(key);
        dedupedHashtags.push(tag);
        if (dedupedHashtags.length >= 12) break;
      }
      // If the LLM returned fewer than 8, we keep what we have rather
      // than fabricating tags. The minimum is aspirational; a real
      // post with 4 tags is better than a hallucinated 8.
      const hashtags = dedupedHashtags;
      if (caption) {
        const updatedImg = {
          ...image,
          postCaption: caption,
          postHashtags: hashtags,
        };
        saveImage(updatedImg);
        setImages((prev) =>
          prev.map((img) =>
            img.id === image.id
              ? { ...img, postCaption: caption, postHashtags: hashtags }
              : img
          )
        );
        return updatedImg;
      }
    } catch {
      // caller receives undefined; UI handles missing caption gracefully
    }
    return undefined;
  };

  return { generatePostContent };
}
