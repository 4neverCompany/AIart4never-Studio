/**
 * v1.2 Tool Registry — `persist_asset` tool tests.
 *
 * Tests the pure helpers (toGeneratedImage, upsertImage, makeAssetId)
 * and the execute() happy/error paths. Storage is mocked via
 * `vi.mock('@/lib/persistence', ...)` so the tests don't touch
 * idb-keyval / tauri-plugin-store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Persistence is mocked so the tests don't touch idb-keyval /
// tauri-plugin-store. We use a factory (allowed by vitest) so the
// `vi.fn()` instances are recreated per-import — no top-level
// "before initialization" race.
vi.mock('@/lib/persistence', () => ({
  get: vi.fn(),
  set: vi.fn(),
  __resetStoreForTests: vi.fn(),
}));

import {
  executePersistAsset,
  persistAssetTool,
  toGeneratedImage,
  upsertImage,
  makeAssetId,
} from '@/lib/agent-tools/persist-asset';
import { ValidationError, AssetPersistError } from '@/lib/agent-tools/errors';
import type { GeneratedImage } from '@/types/mashup';
import * as persistenceModule from '@/lib/persistence';

const persistenceMock = {
  get: persistenceModule.get as ReturnType<typeof vi.fn>,
  set: persistenceModule.set as ReturnType<typeof vi.fn>,
  __resetStoreForTests: persistenceModule.__resetStoreForTests as ReturnType<typeof vi.fn>,
};

const sampleInput = {
  assetRef: { provider: 'higgsfield' as const, id: 'abc-123', url: 'https://x.com/a.png' },
  metadata: { title: 'Vader x Iron Man', tags: ['Marvel', 'Star Wars'], kind: 'image' as const },
};

beforeEach(() => {
  vi.clearAllMocks();
  persistenceMock.get.mockResolvedValue([]);
  persistenceMock.set.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('makeAssetId', () => {
  it('prefixes the kind to the provider id', () => {
    expect(makeAssetId(sampleInput)).toBe('image-abc-123');
  });

  it('uses "video" prefix for video assets', () => {
    expect(makeAssetId({
      ...sampleInput,
      metadata: { ...sampleInput.metadata, kind: 'video' },
    })).toBe('video-abc-123');
  });
});

describe('toGeneratedImage', () => {
  it('maps the input to a GeneratedImage-compatible record', () => {
    const out = toGeneratedImage(sampleInput, 'image-abc-123', 1700000000000);
    expect(out.id).toBe('image-abc-123');
    expect(out.url).toBe('https://x.com/a.png');
    expect(out.prompt).toBe('Vader x Iron Man');
    expect(out.tags).toEqual(['Marvel', 'Star Wars']);
    expect(out.isVideo).toBe(false);
    expect(out.status).toBe('ready');
    expect(out.approved).toBe(false);
    expect(out.savedAt).toBe(1700000000000);
  });

  it('marks video assets with isVideo=true', () => {
    const out = toGeneratedImage(
      { ...sampleInput, metadata: { ...sampleInput.metadata, kind: 'video' } },
      'video-abc-123',
      0,
    );
    expect(out.isVideo).toBe(true);
  });

  it('records the provider in modelInfo for known providers', () => {
    const out = toGeneratedImage(sampleInput, 'image-abc-123', 0);
    expect(out.modelInfo?.provider).toBe('higgsfield');
    expect(out.modelInfo?.modelId).toBe('abc-123');
  });
});

describe('upsertImage', () => {
  const baseImg: GeneratedImage = {
    id: 'image-abc',
    url: 'https://x.com/a.png',
    prompt: 'first',
    status: 'ready',
    savedAt: 1000,
  };

  it('appends a new image to the front of the list', () => {
    const merged = upsertImage([baseImg], { ...baseImg, id: 'image-new', savedAt: 2000 });
    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe('image-new');
  });

  it('replaces in place when id matches and preserves the older savedAt', () => {
    const merged = upsertImage([baseImg], { ...baseImg, prompt: 'updated', savedAt: 2000 });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.prompt).toBe('updated');
    expect(merged[0]?.savedAt).toBe(1000); // older preserved
  });
});

// ---------------------------------------------------------------------------
// execute() — input validation
// ---------------------------------------------------------------------------

describe('executePersistAsset — input validation', () => {
  it('rejects when assetRef is missing', async () => {
    const r = await executePersistAsset({ metadata: sampleInput.metadata });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('rejects when metadata.title is missing', async () => {
    const r = await executePersistAsset({
      assetRef: sampleInput.assetRef,
      metadata: { kind: 'image', tags: [] } as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// execute() — happy path
// ---------------------------------------------------------------------------

describe('executePersistAsset — happy path', () => {
  it('appends a new asset to an empty store', async () => {
    const r = await executePersistAsset(sampleInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.assetId).toBe('image-abc-123');
      expect(typeof r.value.persistedAt).toBe('number');
    }
    expect(persistenceMock.set).toHaveBeenCalledTimes(1);
    const [, written] = persistenceMock.set.mock.calls[0]!;
    expect(Array.isArray(written)).toBe(true);
    expect((written as GeneratedImage[])[0]?.id).toBe('image-abc-123');
  });

  it('replaces an existing asset in place', async () => {
    const existing: GeneratedImage = {
      id: 'image-abc-123',
      url: 'https://old.com/old.png',
      prompt: 'old',
      status: 'ready',
      savedAt: 1000,
    };
    persistenceMock.get.mockResolvedValue([existing]);

    const r = await executePersistAsset({
      ...sampleInput,
      metadata: { ...sampleInput.metadata, title: 'updated title' },
    });
    expect(r.ok).toBe(true);
    const [, written] = persistenceMock.set.mock.calls[0]!;
    const list = written as GeneratedImage[];
    expect(list).toHaveLength(1);
    expect(list[0]?.prompt).toBe('updated title');
    // savedAt preserved from the existing record.
    expect(list[0]?.savedAt).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// execute() — error paths
// ---------------------------------------------------------------------------

describe('executePersistAsset — error paths', () => {
  it('wraps a read failure as AssetPersistError', async () => {
    persistenceMock.get.mockRejectedValue(new Error('idb corrupt'));
    const r = await executePersistAsset(sampleInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(AssetPersistError);
      const e = r.error as AssetPersistError;
      expect(e.assetRefProvider).toBe('higgsfield');
      expect(e.message).toContain('read');
    }
  });

  it('wraps a write failure as AssetPersistError', async () => {
    persistenceMock.set.mockRejectedValue(new Error('quota exceeded'));
    const r = await executePersistAsset(sampleInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(AssetPersistError);
      const e = r.error as AssetPersistError;
      expect(e.message).toContain('write');
    }
  });

  it('treats a non-array stored value as an empty store (graceful)', async () => {
    persistenceMock.get.mockResolvedValue('not-an-array' as never);
    const r = await executePersistAsset(sampleInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.assetId).toBe('image-abc-123');
  });
});

describe('persistAssetTool (Vercel AI SDK shape)', () => {
  it('has a description and schemas', () => {
    const obj = persistAssetTool as unknown as Record<string, unknown>;
    expect(typeof obj.description).toBe('string');
    expect(obj.inputSchema).toBeDefined();
    expect(obj.outputSchema).toBeDefined();
  });
});
