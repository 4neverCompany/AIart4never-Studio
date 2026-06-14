// V050-006: jest-dom matcher extension for jsdom-environment integration
// tests. Adds toBeInTheDocument, toHaveTextContent, etc. to vitest's
// `expect`. Loaded via vitest.config.ts setupFiles. Safe in node env —
// the import only registers matchers; no DOM access happens here.

import '@testing-library/jest-dom/vitest';
