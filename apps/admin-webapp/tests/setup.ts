import { afterEach } from 'vitest';

import { cleanup } from '@testing-library/react';

import '@testing-library/jest-dom/vitest';

// Vitest's `globals` is off (per vitest.shared.ts), so RTL's own auto-cleanup
// never registers — it looks for a global `afterEach`. Without this, every
// component test file leaks its DOM into the next test in the same file.
afterEach(() => {
  cleanup();
  // SettingsProvider (now part of renderWithProviders) persists the
  // "Show UUIDs" preference to localStorage; clear it so one test's toggle
  // doesn't leak into the next.
  localStorage.clear();
});
