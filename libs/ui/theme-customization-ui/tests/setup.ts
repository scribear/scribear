import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest's `globals` is off (see vitest.shared.ts), so register RTL cleanup
// manually to avoid DOM leaking between tests.
afterEach(() => {
  cleanup();
});
