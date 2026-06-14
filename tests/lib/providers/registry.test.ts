/**
 * Tests for lib/providers/registry.
 *
 * Coverage:
 *   - getProvider returns the right adapter for each known id
 *   - getProvider returns the same singleton on repeat calls
 *   - getProvider throws ProviderError for unknown ids
 *   - listProviders returns every built-in with its availability flag
 *   - getFirstAvailable skips unavailable providers in priority order
 *   - requireFirstAvailable throws ProviderUnavailableError when none work
 *   - __registerProvider overrides work; __resetRegistry clears them
 *   - __registerFactory adds a new provider id
 *
 * NOTE: the Higgsfield CLI/text adapters and the Leonardo HTTP adapter
 * were removed in the MiniMax-only strip. `minimax-video` is now the
 * sole built-in. The generic registry mechanics (singleton memoization,
 * overrides, factory registration, first-available walk) are still
 * exercised below — using `minimax-video` and test-registered factories
 * via `__registerFactory` instead of the deleted adapters.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getProvider,
  listProviders,
  getFirstAvailable,
  requireFirstAvailable,
  __registerProvider,
  __registerFactory,
  __resetRegistry,
  BUILTIN_PROVIDER_IDS,
  setProviderRuntimeConfig,
} from '@/lib/providers/registry';
import {
  ProviderError,
  ProviderUnavailableError,
  type ProviderAdapter,
  type GenerateImageOptions,
  type GenerateVideoOptions,
  type AssetRef,
} from '@/lib/providers/interface';

class FakeAdapter implements ProviderAdapter {
  readonly name: string;
  readonly label: string;
  private _available: boolean;
  constructor(name: string, available: boolean) {
    this.name = name;
    this.label = `Fake ${name}`;
    this._available = available;
  }
  async isAvailable(): Promise<boolean> { return this._available; }
  async generateImage(_o: GenerateImageOptions): Promise<AssetRef> {
    return { kind: 'image', provider: this.name };
  }
  async generateVideo(_o: GenerateVideoOptions): Promise<AssetRef> {
    return { kind: 'video', provider: this.name };
  }
}

/** A test-only adapter, registered via __registerFactory so the
 *  factory-catalogue + memoization mechanics can be exercised without
 *  relying on a built-in adapter beyond minimax-video. */
class TestFactoryAdapter implements ProviderAdapter {
  readonly name = 'test-factory';
  readonly label = 'Test Factory';
  async isAvailable(): Promise<boolean> { return true; }
  async generateImage(): Promise<AssetRef> { return { kind: 'image', provider: 'test-factory' }; }
  async generateVideo(): Promise<AssetRef> { return { kind: 'video', provider: 'test-factory' }; }
}

beforeEach(() => {
  __resetRegistry();
});
afterEach(() => {
  __resetRegistry();
});

describe('registry.getProvider', () => {
  it('returns a MinimaxVideoAdapter for "minimax-video"', () => {
    const p = getProvider('minimax-video');
    expect(p.name).toBe('minimax-video');
  });
  it('returns the same singleton on repeated calls', () => {
    const a = getProvider('minimax-video');
    const b = getProvider('minimax-video');
    expect(a).toBe(b);
  });
  it('throws ProviderError for unknown id', () => {
    let caught: unknown;
    try {
      getProvider('does-not-exist');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe('UNKNOWN_PROVIDER');
  });
  it('exposes the full list of built-in provider ids', () => {
    expect(BUILTIN_PROVIDER_IDS).toEqual([
      'minimax-video',
    ]);
  });
});

describe('registry.listProviders', () => {
  it('returns one entry per built-in with its name and adapter', async () => {
    const list = await listProviders();
    expect(list).toHaveLength(BUILTIN_PROVIDER_IDS.length);
    for (const entry of list) {
      expect(typeof entry.name).toBe('string');
      expect(entry.adapter).toBeDefined();
      expect(typeof entry.available).toBe('boolean');
    }
  });

  it('marks a provider with a failing isAvailable() probe as not available', async () => {
    // Override the built-in with a fake that is not available.
    __registerProvider('minimax-video', new FakeAdapter('minimax-video', false));
    const list = await listProviders();
    const m = list.find((p) => p.name === 'minimax-video');
    expect(m).toBeDefined();
    expect(m!.available).toBe(false);
  });
});

describe('registry.getFirstAvailable', () => {
  it('returns the first available provider in priority order', async () => {
    // Built-in unavailable; a test-registered factory is available
    // later in the priority list, so the walk should skip to it.
    __registerProvider('minimax-video', new FakeAdapter('minimax-video', false));
    __registerProvider('a', new FakeAdapter('a', false));
    __registerProvider('b', new FakeAdapter('b', true));
    const p = await getFirstAvailable(['minimax-video', 'a', 'b']);
    expect(p!.name).toBe('b');
  });

  it('returns null when no provider is available', async () => {
    for (const id of BUILTIN_PROVIDER_IDS) {
      __registerProvider(id, new FakeAdapter(id, false));
    }
    expect(await getFirstAvailable()).toBeNull();
  });

  it('respects the priority argument ordering', async () => {
    __registerProvider('minimax-video', new FakeAdapter('minimax-video', true));
    __registerProvider('alt', new FakeAdapter('alt', true));
    // Both available — first in the explicit priority list wins.
    const p = await getFirstAvailable(['alt', 'minimax-video']);
    expect(p!.name).toBe('alt');
  });
});

describe('registry.requireFirstAvailable', () => {
  it('returns the first available provider', async () => {
    __registerProvider('minimax-video', new FakeAdapter('minimax-video', false));
    __registerProvider('a', new FakeAdapter('a', false));
    __registerProvider('b', new FakeAdapter('b', true));
    const p = await requireFirstAvailable(['minimax-video', 'a', 'b']);
    expect(p.name).toBe('b');
  });

  it('throws ProviderUnavailableError when none are available', async () => {
    for (const id of BUILTIN_PROVIDER_IDS) {
      __registerProvider(id, new FakeAdapter(id, false));
    }
    await expect(requireFirstAvailable()).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

describe('registry.__registerProvider / __resetRegistry', () => {
  it('overrides the built-in adapter for an id', () => {
    const fake = new FakeAdapter('minimax-video', true);
    __registerProvider('minimax-video', fake);
    expect(getProvider('minimax-video')).toBe(fake);
  });

  it('__resetRegistry clears overrides and the singleton cache', () => {
    const fake = new FakeAdapter('minimax-video', true);
    __registerProvider('minimax-video', fake);
    __resetRegistry();
    const p = getProvider('minimax-video');
    expect(p).not.toBe(fake);
    expect(p.name).toBe('minimax-video');
  });
});

describe('registry.__registerFactory', () => {
  it('adds a new provider id that getProvider can resolve', () => {
    class CustomAdapter implements ProviderAdapter {
      readonly name = 'custom';
      readonly label = 'Custom';
      async isAvailable() { return true; }
      async generateImage(): Promise<AssetRef> { return { kind: 'image', provider: 'custom' }; }
      async generateVideo(): Promise<AssetRef> { return { kind: 'video', provider: 'custom' }; }
    }
    __registerFactory('custom', CustomAdapter);
    const p = getProvider('custom');
    expect(p.name).toBe('custom');
  });

  it('memoizes the factory-built instance across getProvider() calls', () => {
    __registerFactory('test-factory', TestFactoryAdapter);
    const a = getProvider('test-factory');
    const b = getProvider('test-factory');
    expect(a).toBe(b);
    expect(a.name).toBe('test-factory');
  });

  it('drops the cached instance for a factory-overridden id', () => {
    const before = getProvider('minimax-video');
    class Swap implements ProviderAdapter {
      readonly name = 'minimax-video';
      readonly label = 'swap';
      async isAvailable() { return true; }
      async generateImage(): Promise<AssetRef> { return { kind: 'image', provider: 'minimax-video' }; }
      async generateVideo(): Promise<AssetRef> { return { kind: 'video', provider: 'minimax-video' }; }
    }
    __registerFactory('minimax-video', Swap);
    const after = getProvider('minimax-video');
    expect(after).not.toBe(before);
    expect(after.label).toBe('swap');
  });
});

describe('registry.setProviderRuntimeConfig', () => {
  // The Higgsfield CLI adapter that consumed this token was removed;
  // setProviderRuntimeConfig is now a harmless no-op store. It must
  // remain callable (the Director still passes `{ higgsfieldCliToken }`)
  // and must NOT evict or mutate the existing singleton cache.
  it('is callable and stores config without throwing', () => {
    expect(() =>
      setProviderRuntimeConfig({ higgsfieldCliToken: 'hfg_test_token_123' }),
    ).not.toThrow();
    // Also valid with an empty config object.
    expect(() => setProviderRuntimeConfig({})).not.toThrow();
  });

  it('leaves the singleton cache untouched (no eviction)', () => {
    const before = getProvider('minimax-video');
    setProviderRuntimeConfig({ higgsfieldCliToken: 'hfg_test_token_456' });
    const after = getProvider('minimax-video');
    expect(after).toBe(before);
  });
});
