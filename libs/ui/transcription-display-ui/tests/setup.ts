import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest's `globals` is off (see vitest.shared.ts), so RTL's auto-cleanup never
// self-registers. Clean up the rendered DOM between tests.
afterEach(() => {
  cleanup();
});

// jsdom implements neither ResizeObserver (used by useContainerHeight) nor
// scrollIntoView (used by useAutoScroll). Stub both so the caption container
// renders without throwing.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};
