/**
 * Provider registry — `getProvider(name) → ProviderAdapter` factory.
 *
 * This is the single entry point the Director (lib/agent-tools)
 * uses to look up a provider by id. The factory pattern lets us:
 *   1. Lazy-instantiate adapters (a Higgsfield adapter constructed
 *      at module load would have to run an `isAvailable()` probe
 *      to know whether to expose the CLI binary; lazy is cheaper).
 *   2. Override the default implementation in tests (via
 *      `__registerProvider` and `__resetRegistry`).
 *   3. Centralise the list of "officially supported" providers
 *      (the `listProviders()` export) for UI pickers.
 *
 * The registry does NOT do capability routing (i.e. "which provider
 * can do image generation?") — that lives in lib/agent-tools so
 * the Director can apply its own priority policy.
 */

import {
  type ProviderAdapter,
  ProviderError,
  ProviderUnavailableError,
} from './interface';
import { higgsfieldAdapter, HiggsfieldCliAdapter } from './higgsfield/cli-adapter';
import { higgsfieldTextAdapter, HiggsfieldTextAdapter } from './higgsfield/text-adapter';
import { leonardoAdapter, LeonardoHttpAdapter } from './leonardo/http-adapter';
// M3.3-P3 commit b: minimax-text adapter deleted with the mmx-TEXT
// path. The vercel-ai route is the new home for text/idea/caption
// generation.
import { minimaxVideoAdapter, MinimaxVideoAdapter } from './minimax/video-adapter';

// ---------------------------------------------------------------------------
// Built-in adapter catalogue
// ---------------------------------------------------------------------------

/**
 * The set of provider ids the registry knows about. Used by
 * `listProviders()` and as the canonical name set for the
 * `getProvider()` lookup.
 */
export const BUILTIN_PROVIDER_IDS = [
  'higgsfield',
  'higgsfield-text',
  'leonardo',
  'minimax-video',
] as const;

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

// ---------------------------------------------------------------------------
// Lazy factories
// ---------------------------------------------------------------------------

type AdapterCtor = new (...args: any[]) => ProviderAdapter;

/**
 * V1.2.5: optional runtime config for adapters that need per-user
 * credentials (Higgsfield CLI token). Updated by the Director on
 * each generation cycle so the latest settings.activeSkills /
 * settings.higgsfieldCliToken flow through without re-creating
 * the singleton adapter.
 */
let _runtimeConfig: { higgsfieldCliToken?: string } = {};

export function setProviderRuntimeConfig(cfg: { higgsfieldCliToken?: string }): void {
  _runtimeConfig = cfg;
  // Force the higgsfield singleton to rebuild on the next
  // getProvider() call so the new token takes effect.
  _instances.delete('higgsfield');
}

const FACTORIES: Record<string, () => ProviderAdapter> = {
  higgsfield: () => new HiggsfieldCliAdapter({ cliToken: _runtimeConfig.higgsfieldCliToken }),
  'higgsfield-text': () => new HiggsfieldTextAdapter({ cliToken: _runtimeConfig.higgsfieldCliToken }),
  leonardo: () => new LeonardoHttpAdapter(),
  'minimax-video': () => new MinimaxVideoAdapter(),
};

/** Module-level memoization. The first `getProvider('higgsfield')`
 *  builds the adapter; subsequent calls return the same instance. */
const _instances: Map<string, ProviderAdapter> = new Map<string, ProviderAdapter>();

/** Optional overrides (e.g. from tests or feature flags). */
const _overrides: Map<string, ProviderAdapter> = new Map<string, ProviderAdapter>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a provider by id. Returns the singleton adapter for that
 * provider, creating it on first call. Throws ProviderError if the
 * id is unknown.
 */
export function getProvider(name: string): ProviderAdapter {
  // Override wins (test seam).
  const override = _overrides.get(name);
  if (override) return override;

  // Memoized instance.
  const cached = _instances.get(name);
  if (cached) return cached;

  // Build from the factory catalogue.
  const factory = FACTORIES[name];
  if (!factory) {
    throw new ProviderError(
      'UNKNOWN_PROVIDER',
      `Unknown provider "${name}". Known: ${BUILTIN_PROVIDER_IDS.join(', ')}`,
      'registry',
      'Pass one of the built-in provider ids, or call __registerProvider() to add a custom one.',
    );
  }
  const instance = factory();
  _instances.set(name, instance);
  return instance;
}

/**
 * Return every built-in provider as `{ name, adapter, available }`.
 * `available` is the result of an `isAvailable()` probe — false
 * for CLI providers whose binary is missing, false for HTTP
 * providers whose credentials aren't set.
 *
 * The Director uses this to build its fallback chain: "try
 * higgsfield, then leonardo" — it walks the list in
 * order and uses the first available one.
 */
export async function listProviders(): Promise<Array<{ name: string; adapter: ProviderAdapter; available: boolean }>> {
  const results = await Promise.all(
    BUILTIN_PROVIDER_IDS.map(async (id) => {
      const adapter = getProvider(id);
      let available = false;
      try {
        available = await adapter.isAvailable();
      } catch {
        available = false;
      }
      return { name: id, adapter, available };
    }),
  );
  return results;
}

/**
 * Convenience: return the first provider that responds true to
 * `isAvailable()`. Useful when the Director doesn't care which
 * provider does the work — it just wants the cheapest available
 * image generator.
 *
 * Order is the registration order (BUILTIN_PROVIDER_IDS), which
 * biases toward CLI providers first (cheaper) and HTTP providers
 * last. Override this with the `priority` argument.
 */
export async function getFirstAvailable(
  priority: readonly string[] = BUILTIN_PROVIDER_IDS,
): Promise<ProviderAdapter | null> {
  for (const id of priority) {
    try {
      const adapter = getProvider(id);
      if (await adapter.isAvailable()) return adapter;
    } catch {
      // Skip unknown or broken providers silently.
    }
  }
  return null;
}

/**
 * As above, but throws if no provider is available. The thrown
 * error is a `ProviderUnavailableError` whose message lists every
 * provider that was probed.
 */
export async function requireFirstAvailable(
  priority: readonly string[] = BUILTIN_PROVIDER_IDS,
): Promise<ProviderAdapter> {
  const available = await getFirstAvailable(priority);
  if (available) return available;
  throw new ProviderUnavailableError(
    'registry',
    priority.join(', '),
  );
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Replace the adapter for a given id. Pass `null` to clear the
 *  override and fall back to the built-in factory. */
export function __registerProvider(name: string, adapter: ProviderAdapter | null): void {
  if (adapter === null) {
    _overrides.delete(name);
  } else {
    _overrides.set(name, adapter);
  }
}

/** Register a brand-new factory (e.g. for a custom provider that
 *  isn't in the built-in set). The factory is invoked lazily on
 *  the first `getProvider(name)` call. */
export function __registerFactory(name: string, ctor: AdapterCtor): void {
  FACTORIES[name] = () => new ctor();
  // Drop any cached instance so the new factory takes effect.
  _instances.delete(name);
}

/** Reset the registry to its built-in state. Tests use this in
 *  `afterEach()` so a test's `__registerProvider` doesn't leak. */
export function __resetRegistry(): void {
  _instances.clear();
  _overrides.clear();
  // We don't touch FACTORIES — that's the "add a new provider" axis,
  // not the "swap an existing one" axis. If a test wants to remove
  // a factory, it should call __registerFactory(name, never-resolve)
  // or similar.
}

// ---------------------------------------------------------------------------
// Pre-built singletons (legacy callers that want `import { higgsfieldAdapter }`)
// ---------------------------------------------------------------------------

export {
  higgsfieldAdapter,
  higgsfieldTextAdapter,
  leonardoAdapter,
  minimaxVideoAdapter,
};
