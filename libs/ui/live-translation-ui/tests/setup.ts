import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest's `globals` is off (see vitest.shared.ts), so RTL's auto-cleanup never
// self-registers. Clean up the rendered DOM between tests.
afterEach(() => {
  cleanup();
});

// jsdom implements no layout and neither `Element.scrollTo` (which
// `useAutoScroll` calls to pin the panel to the newest caption) nor
// `scrollIntoView`. Stub both so the panel renders without throwing; tests that
// need a working scroller install `fake-scroller` over these.
Element.prototype.scrollIntoView = () => {};
Element.prototype.scrollTo = () => {};

// jsdom does not implement the `scrollend` event, and nothing here needs it to:
// `useAutoScroll` always runs a settle timer as the universal fallback, so the
// timer path is what this suite exercises. Do not "fix" this by polyfilling it
// - the fallback is the path that runs on Safari before 18.2.
