import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest's `globals` is off (see vitest.shared.ts), so RTL's auto-cleanup — which
// looks for a global `afterEach` — never registers. Without this each test file
// leaks its rendered DOM into the next test.
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement matchMedia, which MUI's useMediaQuery (used by
// AppLayout's responsive header) calls. Provide a stub that reports no match.
globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;
