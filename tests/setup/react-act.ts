// QOL-VITEST-FIX (2026-04-27): mark this process as a React act() environment
// so RTL 16's calls to `React.act` resolve against the development React
// build. Required for React 19 + @testing-library/react 16 under vitest 4
// (without it, `React.act is not a function` fires on every render/cleanup).
// Loaded via vitest.config.ts setupFiles BEFORE jest-dom so the flag is set
// before any test file imports React or RTL.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
