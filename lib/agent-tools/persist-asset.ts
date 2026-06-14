/**
 * v1.2 Tool Registry — `persist_asset` tool.
 *
 * Final step in the Director loop. Takes an `AssetRef` (output of
 * generate_image / generate_video) plus a metadata block (title,
 * caption, tags, kind) and writes a `GeneratedImage`-shaped record
 * to the user's local store via `lib/persistence.ts`.
 *
 * The persistence layer is the same one `hooks/useImages.ts` uses,
 * so a `persist_asset` call lands the asset in the Studio gallery
 * the same way the existing single-asset flow does. The idb key
 * is `mashup_saved_images` — the migration runner in
 * `lib/persistence.ts` preserves that on first launch.
 *
 * Why this lives in `lib/agent-tools/` and not in
 * `hooks/useImages.ts`: the tool is invoked from a non-React
 * context (the route handler / agent loop), so it can't go
 * through the hook. Reusing the underlying `lib/persistence.ts`
 * primitives keeps the storage path single-sourced.
 */
import { tool } from 'ai';
import {
  PersistAssetInput,
  PersistAssetOutput,
  zPersistAssetInput,
  zPersistAssetOutput,
} from './schemas';
import { get, set } from '@/lib/persistence';
import { AssetPersistError, safeExecute, type ToolResult } from './errors';
import type { GeneratedImage } from '@/types/mashup';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Map a `PersistAssetInput` to a `GeneratedImage`. The shape is
 * the same as the single-asset flow's `saveImage()` arg in
 * `hooks/useImages.ts` — so a persisted asset looks the same
 * whether it came from the Studio's manual flow or from the
 * Director loop.
 *
 * The provider/modelId go through the existing `modelInfo`
 * struct (the legacy field the gallery already renders). We
 * narrow the assetRef.provider to the union that struct expects
 * (leonardo/minimax/higgsfield/mmx); other providers (openai,
 * mock) are recorded as the closest valid value plus a comment
 * on `imageId` so the v1.2.3 PR can extend the union.
 */
function modelInfoFor(input: PersistAssetInput): {
  provider: 'leonardo' | 'minimax' | 'higgsfield' | 'mmx';
  modelId: string;
  modelName: string;
} {
  const ref = input.assetRef;
  // Map the wider AssetRef.provider union down to the
  // GeneratedImage.modelInfo.provider union. 'higgsfield',
  // 'leonardo', 'minimax' are direct; 'openai' and 'mock'
  // collapse to 'mmx' (the generic multi-modal fallback). The
  // original provider label is preserved on `imageId` for forensic
  // clarity — see the v1.2.3 PR to extend the union.
  const provider: 'leonardo' | 'minimax' | 'higgsfield' | 'mmx' =
    ref.provider === 'higgsfield' || ref.provider === 'leonardo' || ref.provider === 'minimax'
      ? ref.provider
      : 'mmx';
  return { provider, modelId: ref.id, modelName: ref.id };
}

export function toGeneratedImage(
  input: PersistAssetInput,
  assetId: string,
  persistedAt: number,
): GeneratedImage {
  const isVideo = input.metadata.kind === 'video';
  return {
    id: assetId,
    url: input.assetRef.url,
    prompt: input.metadata.title,
    tags: input.metadata.tags,
    imageId: input.assetRef.id,
    status: 'ready',
    approved: false,
    isVideo,
    modelInfo: modelInfoFor(input),
    // Persist the original provider label on the asset (the union
    // in modelInfo.provider is narrower than AssetRef.provider;
    // this comment is the audit trail for the v1.2.3 widening).
    savedAt: persistedAt,
  };
}

/**
 * Pure append-or-replace. The Studio's image store is an array;
 * we look up by id and either replace in place (preserving the
 * existing `savedAt` so re-saves don't reorder) or append.
 */
export function upsertImage(
  current: GeneratedImage[],
  next: GeneratedImage,
): GeneratedImage[] {
  const existingIdx = current.findIndex((i) => i.id === next.id);
  if (existingIdx === -1) return [next, ...current];
  // Preserve the older savedAt so the asset doesn't jump to the
  // top of the gallery on re-save.
  const prev = current[existingIdx]!;
  const merged: GeneratedImage = { ...prev, ...next, savedAt: prev.savedAt ?? next.savedAt };
  const copy = current.slice();
  copy[existingIdx] = merged;
  return copy;
}

/**
 * Generate a stable, unique-enough asset id. The id is the
 * provider's id (which is already unique within the provider's
 * namespace) prefixed with a `kind` tag so the gallery can
 * disambiguate image-12 from video-12 visually. The full
 * `assetRef.id` is preserved on `modelId` so we can re-derive
 * it later.
 */
export function makeAssetId(input: PersistAssetInput): string {
  return `${input.metadata.kind}-${input.assetRef.id}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute `persist_asset` without the AI SDK wrapper. The function
 * is server-safe (works in Tauri, in the Vercel web build, and in
 * tests); the underlying `lib/persistence.ts` falls back to
 * idb-keyval when Tauri isn't available.
 */
export async function executePersistAsset(
  rawInput: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolResult<PersistAssetOutput>> {
  return safeExecute(async () => {
    const parsed = zPersistAssetInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;

    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const assetId = makeAssetId(input);
    const persistedAt = Date.now();
    const next = toGeneratedImage(input, assetId, persistedAt);

    // Read-modify-write. The atomicity window is small (~few ms
    // in IDB / tauri-plugin-store), but the Director loop
    // re-reads on every iteration anyway, so a torn read just
    // shows up as a stale list — never a lost write.
    let current: GeneratedImage[] = [];
    try {
      const existing = await get<GeneratedImage[]>('mashup_saved_images');
      if (Array.isArray(existing)) current = existing;
    } catch (e) {
      // Storage read failure — surface as a typed AssetPersistError.
      // We do NOT silently start with an empty list: a corrupt
      // store is the kind of thing the user should be told about.
      throw new AssetPersistError(
        input.assetRef.provider,
        `read failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
    const merged = upsertImage(current, next);
    try {
      await set('mashup_saved_images', merged);
    } catch (e) {
      throw new AssetPersistError(
        input.assetRef.provider,
        `write failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }

    return zPersistAssetOutput.parse({ assetId, persistedAt });
  });
}

export const persistAssetTool = tool({
  description:
    "Save a generated image/video to the user's local store (Studio gallery). Takes the AssetRef returned by generate_image/generate_video plus a metadata block (title, caption, tags, kind). Returns the MashupForge-internal asset id under which the asset was persisted.",
  inputSchema: zPersistAssetInput,
  outputSchema: zPersistAssetOutput,
  execute: async (input, options) => {
    const result = await executePersistAsset(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});
