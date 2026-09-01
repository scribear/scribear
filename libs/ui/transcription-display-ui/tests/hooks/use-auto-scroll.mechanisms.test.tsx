/**
 * Mechanism-level tests for `useAutoScroll`.
 *
 * These cover the heart of the fix described in `20260831-FixAutoScroll-PLAN.md`
 * (§3.3 lists the mechanisms, §4.1 the arm/open state machine, §5.1 the
 * implementation; the case numbers in the comments below are the rows of the
 * §6.2 test table):
 *
 *  - every way an engine can move `scrollTop` with no user behind it - the
 *    clamp-vs-growth race (M6), sub-pixel dither (M7), a lagging iOS scroll
 *    replica (M2), a rubber-band settle (M4), a content shrink - must leave
 *    auto-scroll **engaged**;
 *  - a real gesture that actually scrolls back past the threshold must
 *    **disengage**, and stay disengaged for the whole of an iOS momentum ramp;
 *  - and, critically, a gesture that produces *no* scroll must never stop the
 *    captions following the speaker (§4.1: gestures arm, scrolls open).
 *
 * jsdom has no layout, so a real element cannot scroll: `tests/fake-scroller.ts`
 * installs a working scroller model on the container. The timing boundaries are
 * driven with a faked clock that includes `performance`, because the hook times
 * attribution with `performance.now()` - without that, every boundary assertion
 * here would pass vacuously.
 */
import { useCallback } from 'react';

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  PIN_TOLERANCE_PX,
  SCROLL_SETTLE_MS,
  USER_INPUT_ARM_MS,
  type UseAutoScrollResult,
  useAutoScroll,
} from '#src/hooks/use-auto-scroll.js';

import { type FakeScroller, installFakeScroller } from '../fake-scroller.js';

/** Content taller than the viewport, so there is somewhere to scroll. */
const CONTENT_PX = 2000;
const VIEWPORT_PX = 500;
/** The pinned offset for the defaults above. */
const BOTTOM_PX = CONTENT_PX - VIEWPORT_PX;
const LINE_HEIGHT_PX = 40;
/** `max(MIN_SCROLLBACK_PX, lineHeightPx * 1.5)` for a 40px caption line. */
const THRESHOLD_PX = 60;

interface SetupOptions {
  contentPx?: number;
  viewportPx?: number;
  lineHeightPx?: number;
}

/** Distinguishes each instance in the diagnostics registry. */
let instanceCount = 0;

/**
 * Mounts a caption-container stand-in wired to `useAutoScroll`, with a fake
 * scroller installed on the real DOM node.
 *
 * The scroller is installed from the node's ref callback rather than after
 * `render`, because React attaches a host element's ref before it runs the
 * owning component's layout effects - so the hook's very first pin already sees
 * a working scroller, exactly as it would in a browser.
 */
function setupAutoScroll({
  contentPx = CONTENT_PX,
  viewportPx = VIEWPORT_PX,
  lineHeightPx = LINE_HEIGHT_PX,
}: SetupOptions = {}) {
  let scroller: FakeScroller | null = null;
  let latest: UseAutoScrollResult | null = null;
  let contentHeightPx = contentPx;
  instanceCount += 1;
  const label = `mechanisms-${String(instanceCount)}`;

  const Harness = ({ token }: { token: number }) => {
    const result = useAutoScroll([token], { lineHeightPx, label });
    latest = result;
    const { textContainerRef, handleScroll } = result;

    const attach = useCallback(
      (node: HTMLDivElement | null) => {
        if (node !== null && scroller === null) {
          scroller = installFakeScroller(node, {
            contentHeight: contentPx,
            viewportHeight: viewportPx,
            // Start pinned, so the mount-time pin moves nothing and every later
            // offset change is one the test asked for.
            scrollTop: Math.max(0, contentPx - viewportPx),
          });
        }
        textContainerRef.current = node;
      },
      [textContainerRef],
    );

    return <div ref={attach} onScroll={handleScroll} />;
  };

  let token = 0;
  const view = render(<Harness token={token} />);

  const requireScroller = (): FakeScroller => {
    if (scroller === null) throw new Error('fake scroller was not installed');
    return scroller;
  };
  const requireApi = (): UseAutoScrollResult => {
    if (latest === null) throw new Error('useAutoScroll did not render');
    return latest;
  };

  const dispatch = (event: Event) => {
    act(() => {
      requireScroller().el.dispatchEvent(event);
    });
  };

  return {
    get scroller(): FakeScroller {
      return requireScroller();
    },
    get isEngaged(): boolean {
      return requireApi().isAutoScrollEnabled;
    },
    get diagnostics() {
      return requireApi().getDiagnostics();
    },
    get isPinned(): boolean {
      const active = requireScroller();
      return active.scrollTop === active.maxScrollTop;
    },
    /** New caption text arrives: content grows, then React commits. */
    pushContent(growByPx = 120) {
      act(() => {
        contentHeightPx += growByPx;
        requireScroller().setContentHeight(contentHeightPx);
        token += 1;
        view.rerender(<Harness token={token} />);
      });
    },
    setContentHeight(px: number) {
      act(() => {
        contentHeightPx = px;
        requireScroller().setContentHeight(px);
      });
    },
    scrollTo(px: number) {
      act(() => {
        requireScroller().scrollTo(px);
      });
    },
    emitRawScroll(px: number) {
      act(() => {
        requireScroller().emitRawScroll(px);
      });
    },
    clampThenGrow(growViewportBy: number, growContentBy: number) {
      act(() => {
        contentHeightPx += growContentBy;
        requireScroller().clampThenGrow(growViewportBy, growContentBy);
      });
    },
    input(type: 'pointerdown' | 'touchstart' | 'touchmove' | 'touchend') {
      dispatch(new Event(type, { bubbles: true }));
    },
    wheel() {
      dispatch(new WheelEvent('wheel', { bubbles: true, deltaY: -240 }));
    },
    keydown(key: string) {
      dispatch(new KeyboardEvent('keydown', { key, bubbles: true }));
    },
    advance(ms: number) {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    },
    unmount: view.unmount,
  };
}

beforeEach(() => {
  // `performance` must be in the faked set: the hook times attribution with
  // `performance.now()`, not `Date.now()`.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutoScroll test harness', (it) => {
  it('starts engaged and pinned, with a clock the hook can see', () => {
    const view = setupAutoScroll();

    expect(view.isEngaged).toBe(true);
    expect(view.scroller.scrollTop).toBe(BOTTOM_PX);
    // The mount pin went through `scrollTo`, instantly - §3.1.
    expect(view.scroller.scrollToCalls).toContain('instant');

    // Guards every other test in this file: if `performance` were not faked,
    // the arm- and settle-window assertions would silently test nothing.
    const before = performance.now();
    view.advance(1000);
    expect(performance.now() - before).toBe(1000);
  });
});

describe('unattributed scrolls never disengage', (it) => {
  // 1. The primary mechanism (M6): a viewport resize clamps `scrollTop` down,
  // new text lands before the queued scroll event is delivered, and the handler
  // measures the clamped offset against content that is now taller.
  it('keeps following when a clamped offset is measured against grown content', () => {
    const view = setupAutoScroll();

    view.clampThenGrow(200, 300);

    expect(view.isEngaged).toBe(true);
    // Not merely "did not disengage": the hook must have seen a scroll event
    // genuinely far from the bottom and refused to act on it.
    expect(view.diagnostics.suppressedDisengagements).toBe(1);
    expect(view.diagnostics.lastSuppressedDistancePx).toBe(300);
    expect(view.diagnostics.userDisengagements).toBe(0);

    // And the next caption re-pins, so the transient offset self-heals.
    view.pushContent(120);
    expect(view.isPinned).toBe(true);
  });

  // 2. M6 again, from one line of caption text up to ten.
  for (const growthPx of [40, 96, 400]) {
    it(`keeps following when the clamp race grows content by ${String(growthPx)}px`, () => {
      const view = setupAutoScroll();

      view.clampThenGrow(200, growthPx);

      expect(view.isEngaged).toBe(true);
      expect(view.diagnostics.suppressedDisengagements).toBe(1);
      expect(view.diagnostics.lastSuppressedDistancePx).toBe(growthPx);
    });
  }

  // 3. M7: fractional `scrollTop` dither at the bottom. This one has to be
  // absorbed by PIN_TOLERANCE_PX, not by the attribution guard - a quarter of a
  // pixel *is* a pinned view, so nothing may even be recorded as suppressed.
  it('treats sub-pixel dither at the bottom as still pinned', () => {
    const view = setupAutoScroll({ contentPx: 1312.91, viewportPx: 500 });

    view.emitRawScroll(812.91);
    view.emitRawScroll(812.66);

    expect(view.isEngaged).toBe(true);
    expect(view.diagnostics.suppressedDisengagements).toBe(0);
    expect(view.diagnostics.userDisengagements).toBe(0);
  });

  // 4. M2: an iOS scroll-position replica read a few hundred px behind the
  // truth, with no content change and no gesture.
  it('ignores a lagging scroll-position replica read', () => {
    const view = setupAutoScroll();

    view.emitRawScroll(BOTTOM_PX - 300);

    expect(view.isEngaged).toBe(true);
    expect(view.diagnostics.suppressedDisengagements).toBe(1);
    expect(view.diagnostics.lastSuppressedDistancePx).toBe(300);
  });

  // 5. M4: a rubber-band settle is a multi-frame decreasing ramp, and every
  // frame of it looks like "scrolling up, away from the bottom" to a
  // direction-based rule.
  it('ignores a multi-frame decreasing settle ramp', () => {
    const view = setupAutoScroll();

    const ramp = [1500, 1440, 1400, 1370, 1355, 1350];
    for (const offsetPx of ramp) view.emitRawScroll(offsetPx);

    expect(view.isEngaged).toBe(true);
    // The first frame is at the bottom; the other five are far from it and were
    // each seen and refused.
    expect(view.diagnostics.suppressedDisengagements).toBe(ramp.length - 1);
    expect(view.diagnostics.lastSuppressedDistancePx).toBe(150);
    expect(view.diagnostics.userDisengagements).toBe(0);
  });

  // 6. A shorter final hypothesis replacing a long interim one shrinks the
  // content under a pinned offset, and the engine clamps.
  it('ignores a content shrink below the current offset', () => {
    const view = setupAutoScroll();
    expect(view.scroller.scrollTop).toBe(BOTTOM_PX);

    view.setContentHeight(CONTENT_PX - 120);

    expect(view.isEngaged).toBe(true);
    expect(view.isPinned).toBe(true);
    expect(view.diagnostics.userDisengagements).toBe(0);
  });
});

describe('real gestures disengage', (it) => {
  // 7.
  it('disengages when the user wheels back past the threshold', () => {
    const view = setupAutoScroll();

    view.wheel();
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(false);
    expect(view.diagnostics.userDisengagements).toBe(1);
  });

  // 8.
  it('disengages when the user drags back on touch', () => {
    const view = setupAutoScroll();

    view.input('touchstart');
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(false);
    expect(view.diagnostics.userDisengagements).toBe(1);
  });

  // 9. The caption region is `tabIndex={0}` precisely so keyboard and AT users
  // can page back through it.
  it('disengages on a keyboard PageUp', () => {
    const view = setupAutoScroll();

    view.keydown('PageUp');
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(false);
    expect(view.diagnostics.userDisengagements).toBe(1);
  });

  // 13. Complement of case 12 below.
  it('arms on a navigation key', () => {
    const view = setupAutoScroll();

    view.keydown('ArrowUp');
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(false);
    expect(view.diagnostics.userDisengagements).toBe(1);
  });

  // 16. A finger resting on the glass before the drag moves would fall out of
  // the arm window if `touchmove` did not re-arm it.
  it('keeps a slow drag attributed for as long as the finger moves', () => {
    const view = setupAutoScroll();

    view.input('touchstart');
    // Two seconds of drag frames - five times the arm window - with no scroll
    // yet, because the finger has not travelled far enough to move anything.
    for (let elapsedMs = 0; elapsedMs < 2000; elapsedMs += 100) {
      view.advance(100);
      view.input('touchmove');
    }

    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(false);
    expect(view.diagnostics.userDisengagements).toBe(1);
  });

  // 17. iOS momentum keeps firing scroll events for seconds after the finger
  // leaves - long past the arm window, and with gaps wider than the settle
  // window. The disengaged state has to be sticky rather than re-decided per
  // event, or the captions would snap back mid-flick.
  it('stays disengaged for a whole momentum ramp after touchend', () => {
    const view = setupAutoScroll();

    view.input('touchstart');
    view.advance(200);
    view.input('touchmove');
    view.advance(50);
    view.input('touchend');

    // Frames of a decelerating flick, at +400/900/1600/2400/3000ms after the
    // gesture started (§6.2 case 17).
    const ramp: readonly (readonly [afterMs: number, offsetPx: number])[] = [
      [150, BOTTOM_PX - 100],
      [500, BOTTOM_PX - 300],
      [700, BOTTOM_PX - 500],
      [800, BOTTOM_PX - 650],
      [600, BOTTOM_PX - 700],
    ];
    for (const [afterMs, offsetPx] of ramp) {
      view.advance(afterMs);
      view.scrollTo(offsetPx);
      expect(view.isEngaged).toBe(false);
    }

    // Only the first frame is attributed to the flick; the later ones arrive
    // after the settle window has closed and are simply ignored.
    expect(view.diagnostics.userDisengagements).toBe(1);
  });
});

describe('gestures arm but never block pinning', (it) => {
  // 10. The regression from the first draft of the fix (§4.1, §10 H1): an input
  // event opened a session directly, so a tap froze the captions for the settle
  // window. This is the most important case in the file.
  for (const gesture of ['pointerdown', 'touchstart'] as const) {
    it(`keeps pinning after a ${gesture} that produces no scroll`, () => {
      const view = setupAutoScroll();

      view.input(gesture);

      // Five caption updates. The first four are deliberately closer together
      // than SCROLL_SETTLE_MS, so a session wrongly opened by the tap - or by
      // the hook mistaking its own pin for the user - would still be open at
      // the next update and the freeze would compound rather than self-clear.
      const gapsMs = [0, 200, 200, 200, 1400];
      for (const gapMs of gapsMs) {
        view.advance(gapMs);
        view.pushContent(120);
        expect(view.isPinned).toBe(true);
        expect(view.isEngaged).toBe(true);
      }

      expect(view.diagnostics.userDisengagements).toBe(0);
      expect(view.diagnostics.suppressedDisengagements).toBe(0);
    });
  }

  // 11. Repeated taps must not re-arm their way into an indefinite freeze.
  it('keeps pinning through repeated taps', () => {
    const view = setupAutoScroll();

    for (let tap = 0; tap < 10; tap += 1) {
      view.input('pointerdown');
      view.pushContent(120);
      expect(view.isPinned).toBe(true);
      expect(view.isEngaged).toBe(true);
      view.advance(100);
    }

    expect(view.diagnostics.userDisengagements).toBe(0);
  });

  // The complement of 10 and 11: the guard that stops the hook attributing its
  // own pin to the user is scoped to scrolls that land *at the bottom*, which
  // is the only place a pin ever targets. A gesture that scrolls away from the
  // bottom immediately after a pin must still be attributed, or a reader who
  // reaches for the scrollbar just as a caption lands would be ignored.
  it('still attributes a gesture that scrolls away right after a pin', () => {
    const view = setupAutoScroll();

    // A caption update pins - a programmatic scroll at this very instant.
    view.pushContent(120);
    view.wheel();
    view.scrollTo(view.scroller.maxScrollTop - 400);

    expect(view.isEngaged).toBe(false);
    expect(view.diagnostics.userDisengagements).toBe(1);
  });
});

describe('attribution window', (it) => {
  // 12. A bare `keydown` filter would arm on every modifier and character key,
  // which is how a modifier press ends up looking like scroll intent.
  it('does not arm on modifier or character keys', () => {
    const view = setupAutoScroll();

    view.keydown('Control');
    view.keydown('a');
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(true);
    expect(view.diagnostics.suppressedDisengagements).toBe(1);
    expect(view.diagnostics.userDisengagements).toBe(0);
  });

  // 14.
  it('stops attributing scrolls once the arm window has expired', () => {
    const view = setupAutoScroll();

    view.wheel();
    view.advance(USER_INPUT_ARM_MS + 1);
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(true);
    expect(view.diagnostics.suppressedDisengagements).toBe(1);
  });

  // 15. The boundary itself, from both sides.
  it('attributes a scroll just inside the arm window', () => {
    const view = setupAutoScroll();

    view.wheel();
    view.advance(USER_INPUT_ARM_MS - 1);
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(false);
    expect(view.diagnostics.userDisengagements).toBe(1);
  });

  it('does not attribute a scroll just outside the arm window', () => {
    const view = setupAutoScroll();

    view.wheel();
    view.advance(USER_INPUT_ARM_MS + 1);
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(true);
    expect(view.diagnostics.userDisengagements).toBe(0);
  });
});

describe('settle window', (it) => {
  /**
   * Opens a user scroll session without disengaging: a gesture, then - late
   * enough in the arm window that the arm expires before the settle window
   * does - a nudge smaller than the scrollback threshold.
   *
   * Whether a later, otherwise unattributable scroll can disengage is then a
   * direct read-out of whether the session is still open, which is the only
   * observable the settle timer has.
   */
  const openSessionWithoutDisengaging = () => {
    const view = setupAutoScroll();
    view.wheel();
    view.advance(USER_INPUT_ARM_MS - 50);
    view.scrollTo(BOTTOM_PX - 20);
    expect(view.isEngaged).toBe(true);
    expect(view.diagnostics.suppressedDisengagements).toBe(0);
    return view;
  };

  // 18.
  it('keeps the session open just inside the settle window', () => {
    const view = openSessionWithoutDisengaging();

    view.advance(SCROLL_SETTLE_MS - 1);
    // The arm expired 250ms ago, so only a still-open session can let this
    // scroll disengage.
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(false);
    expect(view.diagnostics.userDisengagements).toBe(1);
  });

  it('closes the session just outside the settle window', () => {
    const view = openSessionWithoutDisengaging();

    view.advance(SCROLL_SETTLE_MS + 1);
    view.scrollTo(BOTTOM_PX - 400);

    expect(view.isEngaged).toBe(true);
    expect(view.diagnostics.userDisengagements).toBe(0);
    expect(view.diagnostics.suppressedDisengagements).toBe(1);
  });
});

describe('scrollback threshold', (it) => {
  // 19. Hysteresis: the gap between PIN_TOLERANCE_PX and the threshold is what
  // stops the state flapping when a gesture nudges the view a few pixels.
  it('does not disengage on a nudge smaller than the threshold', () => {
    const view = setupAutoScroll({ lineHeightPx: 40 });

    view.wheel();
    view.scrollTo(BOTTOM_PX - 20);

    // Genuinely out of the pin zone, and genuinely attributed - it is the
    // threshold, not the tolerance and not attribution, doing the work here.
    expect(20).toBeGreaterThan(PIN_TOLERANCE_PX);
    expect(20).toBeLessThan(THRESHOLD_PX);
    expect(view.isEngaged).toBe(true);
    expect(view.diagnostics.userDisengagements).toBe(0);
    expect(view.diagnostics.suppressedDisengagements).toBe(0);
  });

  // 20. On a 96px kiosk caption the threshold is 144px, so the same gesture
  // that disengages at a 40px line height must not disengage here.
  it('scales the threshold with the caption line height', () => {
    const large = setupAutoScroll({ lineHeightPx: 96 });

    large.wheel();
    large.scrollTo(BOTTOM_PX - 100);

    expect(large.isEngaged).toBe(true);
    expect(large.diagnostics.userDisengagements).toBe(0);
    large.unmount();

    // The same 100px scrollback at an ordinary line height clears the 60px
    // threshold, so the two outcomes differ only by `lineHeightPx`.
    const small = setupAutoScroll({ lineHeightPx: 40 });

    small.wheel();
    small.scrollTo(BOTTOM_PX - 100);

    expect(small.isEngaged).toBe(false);
    expect(small.diagnostics.userDisengagements).toBe(1);
  });
});
