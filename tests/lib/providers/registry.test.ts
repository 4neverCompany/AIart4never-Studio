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

beforeEach(() => {
  __resetRegistry();
});
afterEach(() => {
  __resetRegistry();
});

describe('registry.getProvider', () => {
  it('returns a HiggsfieldCliAdapter for "higgsfield"', () => {
    const p = getProvider('higgsfield');
    expect(p.name).toBe('higgsfield');
  });
  it('returns a LeonardoHttpAdapter for "leonardo"', () => {
    const p = getProvider('leonardo');
    expect(p.name).toBe('leonardo');
  });
  it('returns a MinimaxVideoAdapter for "minimax-video"', () => {
    const p = getProvider('minimax-video');
    expect(p.name).toBe('minimax-video');
  });
  it('returns the same singleton on repeated calls', () => {
    const a = getProvider('higgsfield');
    const b = getProvider('higgsfield');
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
      'higgsfield',
      'higgsfield-text',
      'leonardo',
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

  it('marks a provider with a missing CLI as not available', async () => {
    // Override higgsfield with a fake that is not available.
    __registerProvider('higgsfield', new FakeAdapter('higgsfield', false));
    const list = await listProviders();
    const h = list.find((p) => p.name === 'higgsfield');
    expect(h).toBeDefined();
    expect(h!.available).toBe(false);
  });
});

describe('registry.getFirstAvailable', () => {
  it('returns the first available provider in priority order', async () => {
    __registerProvider('higgsfield', new FakeAdapter('higgsfield', false));
    __registerProvider('higgsfield-text', new FakeAdapter('higgsfield-text', false));
    __registerProvider('leonardo', new FakeAdapter('leonardo', true));
    const p = await getFirstAvailable();
    expect(p!.name).toBe('leonardo');
  });

  it('returns null when no provider is available', async () => {
    for (const id of BUILTIN_PROVIDER_IDS) {
      __registerProvider(id, new FakeAdapter(id, false));
    }
    expect(await getFirstAvailable()).toBeNull();
  });

  it('respects the priority argument ordering', async () => {
    for (const id of BUILTIN_PROVIDER_IDS) {
      __registerProvider(id, new FakeAdapter(id, true));
    }
    const p = await getFirstAvailable(['minimax-video', 'leonardo']);
    expect(p!.name).toBe('minimax-video');
  });
});

describe('registry.requireFirstAvailable', () => {
  it('returns the first available provider', async () => {
    __registerProvider('higgsfield', new FakeAdapter('higgsfield', false));
    __registerProvider('higgsfield-text', new FakeAdapter('higgsfield-text', false));
    __registerProvider('leonardo', new FakeAdapter('leonardo', true));
    const p = await requireFirstAvailable();
    expect(p.name).toBe('leonardo');
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
    const fake = new FakeAdapter('higgsfield', true);
    __registerProvider('higgsfield', fake);
    expect(getProvider('higgsfield')).toBe(fake);
  });

  it('__resetRegistry clears overrides and the singleton cache', () => {
    const fake = new FakeAdapter('higgsfield', true);
    __registerProvider('higgsfield', fake);
    __resetRegistry();
    const p = getProvider('higgsfield');
    expect(p).not.toBe(fake);
    expect(p.name).toBe('higgsfield');
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

  it('drops the cached instance for a factory-overridden id', () => {
    const before = getProvider('higgsfield');
    class Swap implements ProviderAdapter {
      readonly name = 'higgsfield';
      readonly label = 'swap';
      async isAvailable() { return true; }
      async generateImage(): Promise<AssetRef> { return { kind: 'image', provider: 'higgsfield' }; }
      async generateVideo(): Promise<AssetRef> { return { kind: 'video', provider: 'higgsfield' }; }
    }
    __registerFactory('higgsfield', Swap);
    const after = getProvider('higgsfield');
    expect(after).not.toBe(before);
  });
});

describe('registry.setProviderRuntimeConfig (V1.2.5)', () => {
  it('forces a fresh Higgsfield adapter instance on the next getProvider() call', () => {
    const before = getProvider('higgsfield');
    setProviderRuntimeConfig({ higgsfieldCliToken: 'hfg_test_token_123' });
    const after = getProvider('higgsfield');
    expect(after).not.toBe(before);
    // Same provider id, same label — only the internal
    // cliToken option should have changed.
    expect(after.name).toBe('higgsfield');
  });

  it('leaves non-higgsfield singleton cache untouched', () => {
    const leoBefore = getProvider('leonardo');
    setProviderRuntimeConfig({ higgsfieldCliToken: 'hfg_test_token_456' });
    const leoAfter = getProvider('leonardo');
    expect(leoAfter).toBe(leoBefore);
  });
});
