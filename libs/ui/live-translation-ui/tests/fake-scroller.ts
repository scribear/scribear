/**
 * jsdom implements no layout, so a real element reports `scrollHeight` 0,
 * ignores writes to `scrollTop`, and never emits a scroll event. This installs
 * a minimal scroller model on an element - settable content and viewport
 * heights, a clamping scroll offset, `scroll` events, and a working `scrollTo`.
 *
 * This mirrors `libs/ui/transcription-display-ui/tests/fake-scroller.ts`,
 * trimmed to what the translated caption panel's tests drive. It is duplicated
 * rather than imported because a package's `tests/` directory is not part of
 * its public exports, so it cannot be reached across the package boundary.
 */
export interface FakeScroller {
  el: HTMLElement;
  /** Grow or shrink the content. Clamps and emits if the offset had to move. */
  setContentHeight: (px: number) => void;
  /** Resize the viewport. Clamps and emits if the offset had to move. */
  setViewportHeight: (px: number) => void;
  /** An engine-driven move: clamps to the valid range, then emits. */
  scrollTo: (px: number) => void;
  /**
   * Emit a scroll event reporting `px` verbatim, bypassing the clamp. Models a
   * stale scroll-position replica (iOS) and any frame an engine reports out of
   * the settled range, such as a rubber-band settle or sub-pixel dither.
   */
  emitRawScroll: (px: number) => void;
  /**
   * Grow the viewport (clamping the offset down against the *old* content
   * height) and grow the content, then emit one scroll event - so the handler
   * sees an offset clamped against the old height measured against the new one.
   * This is the clamp-vs-growth race, the primary cause of the original bug.
   */
  clampThenGrow: (growViewportBy: number, growContentBy: number) => void;
  readonly scrollTop: number;
  readonly maxScrollTop: number;
  readonly contentHeight: number;
  /** The `behavior` given to each `scrollTo` call, in order. */
  readonly scrollToCalls: ScrollBehavior[];
}

interface FakeScrollerInit {
  contentHeight: number;
  viewportHeight: number;
  scrollTop?: number;
}

/**
 * Installs the fake scroller model on `el`, replacing its `scrollHeight`,
 * `clientHeight`, `scrollTop` and `scrollTo` with a working implementation.
 *
 * @param el Element to turn into a scroller.
 * @param init Starting content height, viewport height and offset.
 * @returns Handles for driving the scroller from a test.
 */
export function installFakeScroller(
  el: HTMLElement,
  init: FakeScrollerInit,
): FakeScroller {
  const state = {
    contentHeight: init.contentHeight,
    viewportHeight: init.viewportHeight,
    scrollTop: init.scrollTop ?? 0,
  };
  const scrollToCalls: ScrollBehavior[] = [];

  const maxScrollTop = () =>
    Math.max(0, state.contentHeight - state.viewportHeight);
  const emit = () => {
    el.dispatchEvent(new Event('scroll'));
  };

  /** Applies the engine's clamp; returns true when the offset actually moved. */
  const clamp = () => {
    const clamped = Math.min(Math.max(0, state.scrollTop), maxScrollTop());
    if (clamped === state.scrollTop) return false;
    state.scrollTop = clamped;
    return true;
  };

  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => state.contentHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => state.viewportHeight,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
      clamp();
      emit();
    },
  });
  Object.defineProperty(el, 'scrollTo', {
    configurable: true,
    writable: true,
    value: (options?: ScrollToOptions | number) => {
      if (typeof options === 'object') {
        scrollToCalls.push(options.behavior ?? 'auto');
        state.scrollTop = options.top ?? state.scrollTop;
      } else {
        scrollToCalls.push('auto');
        state.scrollTop = options ?? state.scrollTop;
      }
      clamp();
      emit();
    },
  });

  return {
    el,
    setContentHeight: (px: number) => {
      state.contentHeight = px;
      if (clamp()) emit();
    },
    setViewportHeight: (px: number) => {
      state.viewportHeight = px;
      if (clamp()) emit();
    },
    scrollTo: (px: number) => {
      state.scrollTop = px;
      clamp();
      emit();
    },
    emitRawScroll: (px: number) => {
      state.scrollTop = px;
      emit();
    },
    clampThenGrow: (growViewportBy: number, growContentBy: number) => {
      // The viewport grows first, so the maximum offset drops and the engine
      // clamps the current offset down against the content height as it stands.
      state.viewportHeight += growViewportBy;
      clamp();
      // Then new caption text arrives, before the queued scroll event is
      // delivered - so the handler measures the clamped offset against content
      // that is now taller than it was when the clamp happened.
      state.contentHeight += growContentBy;
      emit();
    },
    get scrollTop() {
      return state.scrollTop;
    },
    get maxScrollTop() {
      return maxScrollTop();
    },
    get contentHeight() {
      return state.contentHeight;
    },
    get scrollToCalls() {
      return scrollToCalls;
    },
  };
}
