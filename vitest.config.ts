import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  // QOL-VITEST-FIX (2026-04-27): force vite to resolve react/react-dom to
  // their development CJS builds. Without this, `react-dom-test-utils`
  // pre-bundles to its production build (which omits `act`), and
  // RTL 16's `React.act(...)` call inside `cleanup()` and `render()`
  // throws `React.act is not a function`. Setting NODE_ENV at config
  // time wins over vitest's runtime default.
  define: {
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
  test: {
    // QOL-VITEST-FIX (2026-04-27): React 19.2 + RTL 16 require
    // `globalThis.IS_REACT_ACT_ENVIRONMENT = true` at module-eval time so
    // that `React.act` is resolved to the development build. We also
    // default to jsdom now (hook/component tests dominate the suite) —
    // pure-function tests in tests/lib/ run fine under jsdom because
    // they never touch the DOM. The previous `environment: 'node'` +
    // per-file `// @vitest-environment jsdom` directive was correct
    // before React 19 / RTL 16, but the upgrade makes jsdom the
    // sensible default.
    include: ['tests/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
    // V105.1-NODE25-LS: Node 25 ships a non-functional localStorage global
    // (it's a stub unless --localstorage-file=<path> is passed). The shim
    // installs a working in-memory localStorage on globalThis BEFORE the
    // test env initializes, so jsdom and happy-dom both get to overwrite
    // it with their own. If they don't, at least tests have a fallback.
    setupFiles: [
      './tests/setup/react-act.ts',
      './tests/setup/node25-localstorage-shim.ts',
      './tests/setup/jest-dom.ts',
    ],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
});
