// Node 25 ships a built-in `globalThis.localStorage` global, but it
// is a non-functional stub unless `--localstorage-file=<path>` is
// passed (the flag has no default value, so without it the stub has
// no `.clear`, no `.removeItem`, etc.). When the test environment
// (jsdom or happy-dom) installs its own localStorage on globalThis,
// the Node 25 stub wins because it was registered first.
//
// This setup file runs BEFORE the test environment, so it can't just
// delete globalThis.localStorage. The fix: install a working in-memory
// localStorage on globalThis that the env's localStorage will overwrite
// when it initializes. If it doesn't (some env configs), at least the
// tests have a functional localStorage to fall back to.
//
// Implementation note (v1.0.6 review fix): on Node 25 the existing
// property descriptor is non-configurable, so `defineProperty` with
// `configurable: true` would throw. Try `defineProperty` first; on
// failure, fall back to a direct assignment, then to a no-op
// (test env is expected to overwrite the global before tests run).
//
// Reference: HANDOFF.md v1.0.6 — the 44-test regression that
// turned out to be Node 25's built-in localStorage, not jsdom/happy-dom
// or any test code.

type MinimalStorage = {
  clear(): void;
  getItem(key: string): string | null;
  key(index: number): string | null;
  length: number;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
};

function makeMemoryStorage(): MinimalStorage {
  const store = new Map<string, string>();
  return {
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    get length() {
      return store.size;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
}

const current = (globalThis as { localStorage?: Partial<MinimalStorage> }).localStorage;
if (!current || typeof current.clear !== 'function') {
  // Either no localStorage at all, or it's Node 25's broken stub.
  // Install a working one — the env will overwrite this when it
  // initializes, but if it doesn't, tests still have something
  // functional to call.
  const shim = makeMemoryStorage();
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: shim,
      writable: true,
      configurable: true,
    });
  } catch {
    // Node 25 marks the built-in localStorage as non-configurable,
    // so defineProperty throws. Fall back to a direct assignment;
    // if that also throws (frozen), the test env is expected to
    // overwrite globalThis.localStorage before any test runs, so
    // we can no-op safely.
    try {
      (globalThis as { localStorage: MinimalStorage }).localStorage = shim;
    } catch {
      // Last resort: leave globalThis.localStorage alone and hope
      // the test env replaces it.
    }
  }
}
