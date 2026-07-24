import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest's `globals` is off (see vitest.shared.ts), so RTL's auto-cleanup — which
// looks for a global `afterEach` — never registers. Without this each test file
// leaks its rendered DOM into the next test.
afterEach(() => {
  cleanup();
});
