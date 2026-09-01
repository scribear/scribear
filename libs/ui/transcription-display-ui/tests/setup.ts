import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest's `globals` is off (see vitest.shared.ts), so RTL's auto-cleanup never
// self-registers. Clean up the rendered DOM between tests.
afterEach(() => {
  cleanup();
});

// jsdom implements neither ResizeObserver (used by useContainerHeight) nor
// Element.scrollTo / scrollIntoView. Stub them so the caption container renders
// without throwing. Tests that need a working scroller install `fake-scroller`
// over these, since jsdom has no layout to make them meaningful.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};
Element.prototype.scrollTo = () => {};

// jsdom does not implement the `scrollend` event, and nothing here needs it to:
// `useAutoScroll` treats `scrollend` as an opportunistic early close and always
// runs a settle timer as the universal fallback, so the timer path is what the
// suite exercises by default. Tests that want the `scrollend` path dispatch a
// synthetic event. Do not "fix" this by polyfilling it - the fallback is the
// path that runs on Safari before 18.2, and it needs the coverage.
