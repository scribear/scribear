import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest's `globals` is off, so @testing-library/react's automatic
// afterEach(cleanup) never registers — we register it explicitly so DOM
// and portals from one test don't leak into the next. Additionally,
// SettingsProvider persists the "Show UUIDs" preference to localStorage,
// so we clear it to prevent cross-test pollution.
afterEach(() => {
  cleanup();
  localStorage.clear();
});
