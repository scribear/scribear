import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest's `globals` is off (see vitest.shared.ts), so RTL's auto-cleanup never
// self-registers. Clean up the rendered DOM between tests.
afterEach(() => {
  cleanup();
});

// jsdom has no scrollIntoView, which the translated caption panel calls to
// follow new text.
Element.prototype.scrollIntoView = () => {};
