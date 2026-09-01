/**
 * Idle re-engage coverage for `useAutoScroll` — plan section 5.4, test-plan
 * rows 39-49 of section 6.2.
 *
 * Section 5.4 exists because a disengage is otherwise an absorbing state: the
 * self-heal in `handleScroll` only re-engages if *something* scrolls back to
 * the bottom, and on an unattended kiosk nothing ever will. The idle timer is
 * the escape hatch, and everything here is about when it must *not* fire.
 *
 * The asymmetry that makes this feature work, and the reason `pointermove`
 * appears in this file and nowhere else in the suite: arming a disengage asks
 * "did the user mean to scroll?" and needs *narrow* evidence
 * (USER_INPUT_EVENTS), because a false positive stops the captions; resetting
 * the idle deadline asks "is anyone still there?" and needs *broad* evidence
 * (IDLE_ACTIVITY_EVENTS = the above plus `pointermove` and `focusin`), because
 * a false positive only makes a walked-away kiosk wait longer while a false
 * negative yanks a present reader out of their place. Hover is worthless as
 * intent and excellent as presence, so it belongs on exactly one of the two
 * lists. Test 42 is the one that proves a laptop reader is never interrupted.
 *
 * Covered here:
 *  39 fires after the configured delay, engaged *and* pinned
 *  40 boundary: disengaged at 179_999ms, engaged at 180_001ms
 *  41 a scroll away from the bottom resets the deadline
 *  42 `pointermove` alone resets the deadline — never re-engages
 *  43 `focusin` resets the deadline
 *  44 presence resets are throttled to IDLE_ACTIVITY_THROTTLE_MS
 *  45 never fires mid-gesture; re-arms and fires once the session closes
 *  46 `idleReengageMs: null` disables it, leaving no pending timer
 *  47 `jumpToBottom` cancels a pending idle timer
 *  48 reaching the bottom cancels a pending idle timer
 *  49 the idle timer is cleared on unmount
 *
 * The clock is faked including `performance` (the hook reads
 * `performance.now()`, deliberately, so an NTP step on a kiosk running for days
 * cannot make a timer fire early or never). Without that in `toFake` the
 * throttle and deadline assertions here would pass vacuously, so the first
 * test in the suite asserts the faked clock actually advances.
 */
import { type RefObject, useEffect } from 'react';

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  IDLE_ACTIVITY_THROTTLE_MS,
  PROGRAMMATIC_SCROLLEND_GRACE_MS,
  SCROLL_SETTLE_MS,
  type UseAutoScrollOptions,
  type UseAutoScrollResult,
  useAutoScroll,
} from '#src/hooks/use-auto-scroll.js';

import { type FakeScroller, installFakeScroller } from '../fake-scroller.js';

/** Production value for the kiosk and the webapps; see section 5.4. */
const IDLE_MS = 180_000;
const FIVE_MINUTES_MS = 300_000;
const THIRTY_MINUTES_MS = 1_800_000;

const CONTENT_PX = 2_000;
const VIEWPORT_PX = 500;
const MAX_SCROLL_PX = CONTENT_PX - VIEWPORT_PX;
/** Well past the 48px scrollback threshold that a 0px line height gives. */
const SCROLLED_BACK_PX = 0;
/** Comfortably clear of PROGRAMMATIC_SCROLLEND_GRACE_MS and SCROLL_SETTLE_MS. */
const MOUNT_SETTLE_MS =
  PROGRAMMATIC_SCROLLEND_GRACE_MS + SCROLL_SETTLE_MS + 1_000;

interface ApiSink {
  current: UseAutoScrollResult | null;
}

interface HarnessProps {
  options: UseAutoScrollOptions;
  publish: (api: UseAutoScrollResult) => void;
}

/**
 * Minimal host for the hook: a real element attached to `textContainerRef` with
 * `handleScroll` wired to `onScroll`, so the layout effects actually run and
 * the imperative listeners actually attach.
 */
function Harness({ options, publish }: HarnessProps) {
  const auto = useAutoScroll([], options);
  const { textContainerRef, handleScroll } = auto;
  // Published from an effect rather than during render, so the test always
  // reads a committed result and nothing is mutated in the render phase.
  useEffect(() => {
    publish(auto);
  });
  return (
    <div
      data-testid="scroller"
      ref={textContainerRef as RefObject<HTMLDivElement | null>}
      onScroll={handleScroll}
    />
  );
}

function setup(options: UseAutoScrollOptions) {
  const sink: ApiSink = { current: null };
  const publish = (api: UseAutoScrollResult) => {
    sink.current = api;
  };
  const view = render(<Harness options={options} publish={publish} />);
  const el = view.getByTestId('scroller');
  const scroller = installFakeScroller(el, {
    contentHeight: CONTENT_PX,
    viewportHeight: VIEWPORT_PX,
    scrollTop: MAX_SCROLL_PX,
  });
  // Step off the mount, which pins programmatically. Everything below is a
  // reader arriving later, so the clock must be outside both the
  // programmatic-scroll grace window and the settle window before the first
  // gesture - otherwise the gesture is mistaken for our own scroll.
  advance(MOUNT_SETTLE_MS);
  /** Re-renders with different options, as a live preference change would. */
  const update = (next: UseAutoScrollOptions) => {
    act(() => {
      view.rerender(<Harness options={next} publish={publish} />);
    });
  };
  return { sink, scroller, unmount: view.unmount, update };
}

/** Reads the latest hook result, failing loudly rather than asserting on null. */
function read(sink: ApiSink): UseAutoScrollResult {
  if (sink.current === null) throw new Error('harness never rendered');
  return sink.current;
}

function isEngaged(sink: ApiSink): boolean {
  return read(sink).isAutoScrollEnabled;
}

function idleReengagements(sink: ApiSink): number {
  return read(sink).getDiagnostics().idleReengagements;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function dispatch(scroller: FakeScroller, type: string): void {
  act(() => {
    scroller.el.dispatchEvent(new Event(type));
  });
}

/**
 * Disengages the way a reader does: an input gesture arms attribution, then a
 * scroll inside that window carries it past the scrollback threshold. Nothing
 * else may disengage, so every test below starts here.
 */
function disengage(scroller: FakeScroller): void {
  act(() => {
    scroller.el.dispatchEvent(new Event('wheel'));
    scroller.scrollTo(SCROLLED_BACK_PX);
  });
}

/** Lets the scroll settle timer close the session opened by `disengage`. */
function closeGestureSession(): void {
  advance(SCROLL_SETTLE_MS + 1);
}

describe('useAutoScroll idle re-engage', (it) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sanity: the faked clock advances performance.now()', () => {
    const before = performance.now();
    vi.advanceTimersByTime(1_234);
    expect(performance.now() - before).toBe(1_234);
  });

  it('39: re-engages and pins after the configured delay', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    expect(isEngaged(sink)).toBe(false);
    expect(scroller.scrollTop).toBe(SCROLLED_BACK_PX);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    advance(IDLE_MS);

    expect(isEngaged(sink)).toBe(true);
    // The flag alone is not the feature: the layout effect must have pinned.
    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(idleReengagements(sink)).toBe(1);
  });

  it('40: boundary — disengaged at 179_999ms, engaged at 180_001ms', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    expect(isEngaged(sink)).toBe(false);

    advance(IDLE_MS - 1);
    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);

    advance(2);
    expect(isEngaged(sink)).toBe(true);
    expect(idleReengagements(sink)).toBe(1);
  });

  it('41: a scroll the reader made resets the deadline', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();

    advance(170_000 - (SCROLL_SETTLE_MS + 1));
    // A gesture, then movement: this is the reader still working through the
    // history, which is what should push the deadline out. Still far from the
    // bottom, so it must not re-engage either.
    act(() => {
      scroller.el.dispatchEvent(new Event('wheel'));
      scroller.scrollTo(SCROLLED_BACK_PX + 100);
    });
    expect(isEngaged(sink)).toBe(false);

    // The original deadline (t0 + 180s) passes with nothing happening.
    advance(10_000);
    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);

    // The pushed-out deadline is t0 + 170s + 180s = t0 + 350s.
    advance(169_999);
    expect(isEngaged(sink)).toBe(false);
    advance(2);
    expect(isEngaged(sink)).toBe(true);
    expect(idleReengagements(sink)).toBe(1);
  });

  it('41b: an unattributed scroll does NOT reset the deadline', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();

    advance(170_000 - (SCROLL_SETTLE_MS + 1));
    // No gesture: this is the engine moving the offset, e.g. a resize clamp on
    // a kiosk being rotated. It is not evidence that a reader is present, and
    // treating it as such would let a kiosk that resizes periodically defer
    // the idle re-engage forever - the display never recovering on its own.
    act(() => {
      scroller.scrollTo(SCROLLED_BACK_PX + 100);
    });
    expect(isEngaged(sink)).toBe(false);

    // So the ORIGINAL deadline still stands, unmoved.
    advance(10_000);
    expect(isEngaged(sink)).toBe(true);
    expect(idleReengagements(sink)).toBe(1);
  });

  it('41c: changing idleReengageMs while disengaged re-arms the deadline', () => {
    const { sink, scroller, update } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();
    advance(60_000);
    expect(isEngaged(sink)).toBe(false);

    // The preference changes mid-session. The effect that owns the timer
    // re-runs and its cleanup clears the pending one; without an explicit
    // re-arm the deadline would be silently dropped and an unattended display
    // would never recover on its own again.
    update({ idleReengageMs: 20_000 });

    // The new deadline governs, measured from the change - not the old one, and
    // emphatically not "never".
    advance(19_999);
    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);

    advance(2);
    expect(isEngaged(sink)).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(idleReengagements(sink)).toBe(1);
  });

  it('41d: switching idleReengageMs to null while disengaged stops the timer', () => {
    const { sink, scroller, update } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    update({ idleReengageMs: null });

    advance(THIRTY_MINUTES_MS);
    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);
  });

  it('41e: a focused caption region is never yanked to the bottom', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();

    // Someone is reading the history with the keyboard or a screen reader and
    // is producing no presence events, because they are not moving. Focus is
    // the evidence that they are still here; moving the view out from under
    // them is the WCAG 2.2.2 concern this timer raises.
    scroller.el.tabIndex = 0;
    act(() => {
      scroller.el.focus();
    });
    expect(document.activeElement).toBe(scroller.el);

    advance(IDLE_MS * 3);
    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);
    expect(scroller.scrollTop).toBe(SCROLLED_BACK_PX);

    // Once they leave, unattended recovery resumes.
    act(() => {
      scroller.el.blur();
    });
    advance(IDLE_MS);
    expect(isEngaged(sink)).toBe(true);
    expect(idleReengagements(sink)).toBe(1);
  });

  it('42: pointermove alone keeps a present reader from being interrupted', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();

    // Five minutes of a mouse drifting over the captions and nothing else: no
    // scrolling, no clicks, no keys. `pointermove` is presence, not intent.
    for (let elapsed = 0; elapsed < FIVE_MINUTES_MS; elapsed += 30_000) {
      advance(30_000);
      dispatch(scroller, 'pointermove');
      expect(isEngaged(sink)).toBe(false);
    }

    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);
    expect(scroller.scrollTop).toBe(SCROLLED_BACK_PX);
  });

  it('43: focusin resets the deadline', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();

    advance(170_000 - (SCROLL_SETTLE_MS + 1));
    dispatch(scroller, 'focusin');

    // The original deadline goes by untouched.
    advance(20_000);
    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);

    // It fires 180s after the focusin instead.
    advance(159_999);
    expect(isEngaged(sink)).toBe(false);
    advance(2);
    expect(isEngaged(sink)).toBe(true);
  });

  it('44: presence resets are throttled to IDLE_ACTIVITY_THROTTLE_MS', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    // A pointer crossing the captions fires ~120 of these a second. All 500
    // land on the same tick of the faked clock, so only the first may re-arm.
    act(() => {
      for (let i = 0; i < 500; i += 1) {
        scroller.el.dispatchEvent(new Event('pointermove'));
      }
    });
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    // Inside the throttle window: still nothing, however many events arrive.
    setTimeoutSpy.mockClear();
    advance(IDLE_ACTIVITY_THROTTLE_MS - 1);
    act(() => {
      for (let i = 0; i < 50; i += 1) {
        scroller.el.dispatchEvent(new Event('pointermove'));
      }
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    // Once the window has elapsed, the next event re-arms exactly once.
    advance(2);
    setTimeoutSpy.mockClear();
    act(() => {
      for (let i = 0; i < 50; i += 1) {
        scroller.el.dispatchEvent(new Event('pointermove'));
      }
    });
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
    expect(isEngaged(sink)).toBe(false);
  });

  it('45: never fires mid-gesture; re-arms until the session closes', () => {
    // Deliberately shorter than SCROLL_SETTLE_MS. With the production 180s the
    // guard is unreachable: every scroll both opens the session and pushes the
    // deadline 180s out, while the session closes 300ms later. Only a delay
    // below the settle window lets the deadline elapse with a finger still
    // notionally on the glass, which is the branch under test.
    const shortIdleMs = 100;
    const { sink, scroller } = setup({ idleReengageMs: shortIdleMs });

    // Opens a user scroll session and disengages in one go.
    disengage(scroller);
    expect(isEngaged(sink)).toBe(false);

    // Two deadlines elapse while the session is still open (it closes at
    // SCROLL_SETTLE_MS = 300ms). Both must re-arm rather than fire.
    advance(250);
    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Close the session deterministically rather than racing the settle timer.
    dispatch(scroller, 'scrollend');
    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);

    // Now, and only now, the re-armed deadline is allowed to fire.
    advance(shortIdleMs);
    expect(isEngaged(sink)).toBe(true);
    expect(idleReengagements(sink)).toBe(1);
    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
  });

  it('46: idleReengageMs null disables it entirely', () => {
    const { sink, scroller } = setup({ idleReengageMs: null });

    disengage(scroller);
    expect(isEngaged(sink)).toBe(false);

    closeGestureSession();
    // Nothing is left armed once the gesture session's settle timer has run.
    expect(vi.getTimerCount()).toBe(0);

    advance(THIRTY_MINUTES_MS);

    expect(isEngaged(sink)).toBe(false);
    expect(idleReengagements(sink)).toBe(0);
    expect(scroller.scrollTop).toBe(SCROLLED_BACK_PX);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('47: jumpToBottom cancels a pending idle timer', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();
    expect(isEngaged(sink)).toBe(false);
    // Only the idle timer is left; the gesture's settle timer has already run.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      read(sink).jumpToBottom();
    });
    expect(isEngaged(sink)).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(vi.getTimerCount()).toBe(0);

    advance(FIVE_MINUTES_MS);

    // Engaged once, by the jump - the idle timer must not fire behind it.
    expect(isEngaged(sink)).toBe(true);
    expect(idleReengagements(sink)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('48: reaching the bottom cancels a pending idle timer', () => {
    const { sink, scroller } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    closeGestureSession();
    expect(isEngaged(sink)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      scroller.el.dispatchEvent(new Event('wheel'));
      scroller.scrollTo(MAX_SCROLL_PX);
    });
    expect(isEngaged(sink)).toBe(true);

    closeGestureSession();
    expect(vi.getTimerCount()).toBe(0);

    advance(FIVE_MINUTES_MS);

    expect(isEngaged(sink)).toBe(true);
    expect(idleReengagements(sink)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('49: the idle timer is cleared on unmount', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { sink, scroller, unmount } = setup({ idleReengageMs: IDLE_MS });

    disengage(scroller);
    expect(isEngaged(sink)).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => {
      unmount();
    });
    expect(vi.getTimerCount()).toBe(0);

    advance(FIVE_MINUTES_MS);

    // No orphaned timer, no state update on an unmounted tree, no act warning.
    expect(vi.getTimerCount()).toBe(0);
    expect(idleReengagements(sink)).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
