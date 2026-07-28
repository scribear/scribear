import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest's `globals` is off (per vitest.shared.ts), so RTL's own auto-cleanup
// never registers - it looks for a global `afterEach`. Without this, every
// component test file leaks its DOM into the next test in the same file.
afterEach(() => {
  cleanup();
});
