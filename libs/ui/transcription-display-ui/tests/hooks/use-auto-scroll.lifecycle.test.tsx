/**
 * Lifecycle, threshold-boundary and multi-instance coverage for
 * `useAutoScroll` - cases 21-38 of the test table in section 6.2 of
 * `20260831-FixAutoScroll-PLAN.md`. The mechanism cases (1-20) and the idle
 * re-engage cases (39-49) live in sibling files.
 *
 * What is covered here:
 * - the `>` (not `>=`) scrollback comparison, and its recomputation when
 *   `lineHeightPx` changes mid-session (21, 22);
 * - the self-healing return to the bottom, attributed or not, including the
 *   mid-gesture transient it produces (23, 24, 25, 26);
 * - how the pin itself is performed - instantly, never `scrollIntoView`, and
 *   never while a scroll is genuinely in flight (27, 28, 29);
 * - collapse of the content to nothing, i.e. `clearTranscription` (30, 31);
 * - `jumpToBottom` inside the settle window, the case that makes the pin layout
 *   effect insufficient on its own (32);
 * - the `scrollend` grace window that keeps our own instant write from
 *   discarding the user's gesture (33, 34);
 * - mount/unmount hygiene, including `StrictMode` (35, 36);
 * - two accepted-limitation / isolation decisions recorded as assertions
 *   (37, 38).
 *
 * The hook only ever sees a scroller through the DOM, so every test drives a
 * real element with `installFakeScroller` (jsdom has no layout) mounted through
 * a small harness component, so the hook's layout effects genuinely run.
 *
 * Note on timing: `handleScroll` treats a scroll event as its own pin's echo
 * when it lands at the bottom within `PROGRAMMATIC_SCROLLEND_GRACE_MS` of that
 * pin, and refuses to open a user session for it. A test that deliberately
 * scrolls INTO the pin zone must therefore step the clock clear of the previous
 * pin first; the `mount` helper does that once for the mount-time pin.
 */
import { StrictMode, useCallback, useLayoutEffect, useRef } from 'react';

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { readAutoScrollDiagnostics } from '#src/hooks/auto-scroll-debug.js';
import {
  PIN_TOLERANCE_PX,
  PROGRAMMATIC_SCROLLEND_GRACE_MS,
  SCROLL_SETTLE_MS,
  USER_INPUT_ARM_MS,
  useAutoScroll,
} from '#src/hooks/use-auto-scroll.js';
import type { UseAutoScrollResult } from '#src/hooks/use-auto-scroll.js';

import { type FakeScroller, installFakeScroller } from '../fake-scroller.js';

// A scroller four times taller than its viewport: maximum offset 1500.
const CONTENT_PX = 2000;
const VIEWPORT_PX = 500;
const MAX_SCROLL_PX = CONTENT_PX - VIEWPORT_PX;

// The threshold is max(MIN_SCROLLBACK_PX, lineHeightPx * 1.5), so a 40px line
// height gives 60px - clear of the 48px floor, which means a test that changes
// the line height actually changes the threshold.
const LINE_HEIGHT_PX = 40;
const THRESHOLD_PX = 60;
/** Far enough back to disengage under any line height used here. */
const WELL_PAST_THRESHOLD_PX = 400;
/** Comfortably outside the "that scroll was our own pin" window. */
const CLEAR_OF_PIN_MS = PROGRAMMATIC_SCROLLEND_GRACE_MS + 50;

interface HarnessProps {
  contentKey: number;
  lineHeightPx: number;
  label: string;
  contentHeight: number;
  viewportHeight: number;
  onRender: (result: UseAutoScrollResult) => void;
  onScrollerReady: (scroller: FakeScroller) => void;
}

/**
 * Minimal stand-in for the caption container: one scrollable div wired exactly
 * as `transcription-display-container.tsx` wires it (`textContainerRef` plus
 * `onScroll={handleScroll}`), and a sibling used by case 37.
 *
 * The fake scroller is installed from the ref callback, which React runs before
 * layout effects, so the hook's first pin already sees a working scroller.
 */
function Harness({
  contentKey,
  lineHeightPx,
  label,
  contentHeight,
  viewportHeight,
  onRender,
  onScrollerReady,
}: HarnessProps) {
  const result = useAutoScroll([contentKey], { lineHeightPx, label });

  // Published from an effect rather than assigned during render: a test needs
  // the latest return value, and writing to a box mid-render is a side effect
  // the React lint rules (rightly) reject.
  useLayoutEffect(() => {
    onRender(result);
  });

  const { textContainerRef, handleScroll } = result;
  const installedRef = useRef(false);

  const attachScroller = useCallback(
    (el: HTMLDivElement | null) => {
      textContainerRef.current = el;
      // StrictMode detaches and reattaches the ref; the scroller model must
      // only be installed over the element's own accessors once.
      if (el === null || installedRef.current) return;
      installedRef.current = true;
      onScrollerReady(
        installFakeScroller(el, { contentHeight, viewportHeight }),
      );
    },
    [textContainerRef, onScrollerReady, contentHeight, viewportHeight],
  );

  return (
    <div>
      <div data-testid={`sibling-${label}`} />
      <div
        data-testid={`scroller-${label}`}
        ref={attachScroller}
        onScroll={handleScroll}
      />
    </div>
  );
}

interface MountOptions {
  lineHeightPx?: number;
  label?: string;
  contentHeight?: number;
  viewportHeight?: number;
  strict?: boolean;
}

interface Handle {
  scroller: FakeScroller;
  sibling: HTMLElement;
  hook: () => UseAutoScrollResult;
  enabled: () => boolean;
  /** Re-render with a new content key, i.e. one caption update. */
  update: (next?: { lineHeightPx?: number }) => void;
  unmount: () => void;
}

let nextLabelId = 0;

/** A label unique to each mount, so the diagnostics registry never collides. */
function nextLabel(): string {
  nextLabelId += 1;
  return `harness-${String(nextLabelId)}`;
}

/**
 * Mounts the harness inside `act` and returns handles for driving it. Every
 * mutation a test makes is wrapped in `act`, so React's act-environment warning
 * is a genuine signal (cases 35 and 36 assert on it).
 */
function mount({
  lineHeightPx = LINE_HEIGHT_PX,
  label = nextLabel(),
  contentHeight = CONTENT_PX,
  viewportHeight = VIEWPORT_PX,
  strict = false,
}: MountOptions = {}): Handle {
  const hookBox: { latest: UseAutoScrollResult | null } = { latest: null };
  const onRender = (result: UseAutoScrollResult) => {
    hookBox.latest = result;
  };
  const scrollerBox: { installed: FakeScroller | null } = { installed: null };
  const onScrollerReady = (ready: FakeScroller) => {
    scrollerBox.installed = ready;
  };

  let contentKey = 0;
  let currentLineHeightPx = lineHeightPx;
  const tree = () => {
    const harness = (
      <Harness
        contentKey={contentKey}
        lineHeightPx={currentLineHeightPx}
        label={label}
        contentHeight={contentHeight}
        viewportHeight={viewportHeight}
        onRender={onRender}
        onScrollerReady={onScrollerReady}
      />
    );
    return strict ? <StrictMode>{harness}</StrictMode> : harness;
  };

  let rendered!: ReturnType<typeof render>;
  act(() => {
    rendered = render(tree());
  });

  const installed = scrollerBox.installed;
  if (installed === null) {
    throw new Error('fake scroller was never installed');
  }

  const handle: Handle = {
    scroller: installed,
    sibling: rendered.getByTestId(`sibling-${label}`),
    hook: () => {
      if (hookBox.latest === null) throw new Error('harness not mounted');
      return hookBox.latest;
    },
    enabled: () => {
      if (hookBox.latest === null) throw new Error('harness not mounted');
      return hookBox.latest.isAutoScrollEnabled;
    },
    update: (next) => {
      contentKey += 1;
      if (next?.lineHeightPx !== undefined) {
        currentLineHeightPx = next.lineHeightPx;
      }
      act(() => {
        rendered.rerender(tree());
      });
    },
    unmount: () => {
      act(() => {
        rendered.unmount();
      });
    },
  };

  // Mounting pins. A scroll that lands at the bottom within the grace window
  // of a pin is treated as that pin's own echo, so step clear of it: the cases
  // that open a session by scrolling INTO the pin zone (28, 34) need their
  // gesture attributed, as it would be for any reader who did not flick in the
  // same millisecond the region appeared.
  advance(CLEAR_OF_PIN_MS);
  return handle;
}

/** Dispatches a real gesture on an element, arming attribution. */
function wheel(target: HTMLElement) {
  act(() => {
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
  });
}

function scrollTo(scroller: FakeScroller, px: number) {
  act(() => {
    scroller.scrollTo(px);
  });
}

function emitRawScroll(scroller: FakeScroller, px: number) {
  act(() => {
    scroller.emitRawScroll(px);
  });
}

function scrollEnd(scroller: FakeScroller) {
  act(() => {
    scroller.el.dispatchEvent(new Event('scrollend'));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Arms with a wheel, then scrolls back far enough to disengage. */
function userScrollsBack(
  handle: Handle,
  offset = MAX_SCROLL_PX - WELL_PAST_THRESHOLD_PX,
) {
  wheel(handle.scroller.el);
  scrollTo(handle.scroller, offset);
}

beforeEach(() => {
  // `performance` must be faked too: attribution, the programmatic-scroll grace
  // window and the idle throttle all compare `performance.now()` against a
  // stored stamp, so a real clock would collapse every window to ~0ms.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useAutoScroll thresholds and self-healing', (it) => {
  it('21: disengages one pixel past the threshold, not at it', () => {
    const handle = mount();
    expect(handle.enabled()).toBe(true);

    // Exactly `scrollbackThresholdPx` from the bottom. The comparison is `>`,
    // so this must NOT disengage; `>=` would fail here.
    wheel(handle.scroller.el);
    scrollTo(handle.scroller, MAX_SCROLL_PX - THRESHOLD_PX);
    expect(CONTENT_PX - handle.scroller.scrollTop - VIEWPORT_PX).toBe(
      THRESHOLD_PX,
    );
    expect(handle.enabled()).toBe(true);
    expect(handle.hook().getDiagnostics().userDisengagements).toBe(0);

    // One pixel further back, still inside the same open session.
    scrollTo(handle.scroller, MAX_SCROLL_PX - THRESHOLD_PX - 1);
    expect(handle.enabled()).toBe(false);
    expect(handle.hook().getDiagnostics().userDisengagements).toBe(1);
  });

  it('22: recomputes the threshold when lineHeightPx changes mid-session', () => {
    const handle = mount({ lineHeightPx: 40 });

    // Disengage against the 60px threshold.
    userScrollsBack(handle, MAX_SCROLL_PX - 200);
    expect(handle.enabled()).toBe(false);
    expect(handle.hook().getDiagnostics().userDisengagements).toBe(1);

    // The reader bumps the caption size: 96 * 1.5 gives a 144px threshold.
    handle.update({ lineHeightPx: 96 });
    expect(handle.enabled()).toBe(false);

    // 100px back is past the old threshold but inside the new one, so it must
    // not be recorded as a fresh disengage. We stay disengaged either way -
    // only reaching the bottom re-engages - so the counter is what proves the
    // threshold actually moved.
    scrollTo(handle.scroller, MAX_SCROLL_PX - 100);
    expect(handle.enabled()).toBe(false);
    expect(handle.hook().getDiagnostics().userDisengagements).toBe(1);

    // Past the new threshold, it is recorded again.
    scrollTo(handle.scroller, MAX_SCROLL_PX - 200);
    expect(handle.enabled()).toBe(false);
    expect(handle.hook().getDiagnostics().userDisengagements).toBe(2);
  });

  it('23: re-engages when the user scrolls back to the bottom', () => {
    const handle = mount();

    userScrollsBack(handle);
    expect(handle.enabled()).toBe(false);

    wheel(handle.scroller.el);
    scrollTo(handle.scroller, MAX_SCROLL_PX);
    expect(handle.enabled()).toBe(true);
    expect(handle.scroller.scrollTop).toBe(handle.scroller.maxScrollTop);
  });

  it('24: re-engages on an unattributed arrival at the bottom', () => {
    const handle = mount();

    userScrollsBack(handle);
    expect(handle.enabled()).toBe(false);

    // Let the session close, so nothing about the next scroll is the user's.
    advance(SCROLL_SETTLE_MS + 1);

    // Deliberately ungated (see the hook's doc comment: "Arriving at the bottom
    // always re-engages, whoever put it there"). This is the path that stops a
    // false disengage from ever being permanent.
    emitRawScroll(handle.scroller, MAX_SCROLL_PX);
    expect(handle.enabled()).toBe(true);
  });

  it('25: does not suppress a mid-gesture re-engage, and ends disengaged', () => {
    const handle = mount();

    userScrollsBack(handle);
    expect(handle.enabled()).toBe(false);

    // The same gesture drags back through the pin zone. Re-engaging here is a
    // transient the ungated self-heal deliberately allows.
    scrollTo(handle.scroller, MAX_SCROLL_PX - PIN_TOLERANCE_PX);
    expect(handle.enabled()).toBe(true);

    // ...and back out again. The session is still open, so this disengages once
    // more and the gesture ends where the finger left it.
    scrollTo(handle.scroller, MAX_SCROLL_PX - WELL_PAST_THRESHOLD_PX);
    expect(handle.enabled()).toBe(false);
    expect(handle.hook().getDiagnostics().userDisengagements).toBe(2);
  });

  it('26: re-engages when a resize clamps the offset to the new bottom', () => {
    const handle = mount();

    userScrollsBack(handle, MAX_SCROLL_PX - 400);
    expect(handle.enabled()).toBe(false);
    advance(SCROLL_SETTLE_MS + 1);

    // Growing the viewport to 950 drops the maximum offset to 1050, below the
    // current 1100, so the engine clamps and emits an unattributed scroll that
    // lands exactly at the bottom. Intended, not accidental: the bottom check
    // runs before the attribution gate precisely so a layout change that parks
    // us at the bottom is honoured.
    act(() => {
      handle.scroller.setViewportHeight(950);
    });
    expect(handle.scroller.scrollTop).toBe(handle.scroller.maxScrollTop);
    expect(handle.enabled()).toBe(true);
  });
});

describe('useAutoScroll pinning', (it) => {
  it('27: pins instantly and never via scrollIntoView', () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const handle = mount();

    const before = handle.scroller.scrollToCalls.length;
    expect(before).toBeGreaterThan(0); // the mount pin

    act(() => {
      handle.scroller.setContentHeight(CONTENT_PX + 300);
    });
    handle.update();

    expect(handle.scroller.scrollToCalls.length).toBeGreaterThan(before);
    // `scrollIntoView` would scroll every scrollable ancestor, and a smooth
    // animation would be re-targeted by the next caption update and never
    // settle. Both are forbidden.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(handle.scroller.scrollToCalls).toContain('instant');
    expect(
      handle.scroller.scrollToCalls.every((behavior) => behavior === 'instant'),
    ).toBe(true);
    expect(handle.scroller.scrollTop).toBe(handle.scroller.maxScrollTop);
  });

  it('28: does not pin while a scroll is actually in flight', () => {
    const handle = mount();

    // Open a session BY SCROLLING - an armed gesture alone must never block
    // pinning (that was the rev-1 bug). Land inside the pin zone so we stay
    // engaged and it is the in-flight guard, not the flag, doing the work.
    wheel(handle.scroller.el);
    scrollTo(handle.scroller, MAX_SCROLL_PX - PIN_TOLERANCE_PX);
    expect(handle.enabled()).toBe(true);

    const offsetBefore = handle.scroller.scrollTop;
    const callsBefore = handle.scroller.scrollToCalls.length;

    act(() => {
      handle.scroller.setContentHeight(CONTENT_PX + 400);
    });
    handle.update();

    expect(handle.scroller.scrollTop).toBe(offsetBefore);
    expect(handle.scroller.scrollToCalls.length).toBe(callsBefore);

    // Once the session settles, the next update pins again.
    advance(SCROLL_SETTLE_MS + 1);
    handle.update();
    expect(handle.scroller.scrollTop).toBe(handle.scroller.maxScrollTop);
  });

  it('29: re-pins after a viewport resize while engaged', () => {
    const handle = mount();
    expect(handle.scroller.scrollTop).toBe(MAX_SCROLL_PX);

    // Shrinking the viewport raises the maximum offset, so the existing offset
    // is no longer the bottom and the engine emits no scroll event at all.
    act(() => {
      handle.scroller.setViewportHeight(400);
    });
    expect(handle.scroller.scrollTop).toBeLessThan(
      handle.scroller.maxScrollTop,
    );

    act(() => {
      handle.scroller.setContentHeight(CONTENT_PX + 200);
    });
    handle.update();

    expect(handle.enabled()).toBe(true);
    expect(handle.scroller.scrollTop).toBe(handle.scroller.maxScrollTop);
  });

  it('30: survives clearTranscription while engaged', () => {
    const handle = mount();
    expect(handle.enabled()).toBe(true);

    // The content collapses far below the viewport height: the maximum offset
    // becomes 0 and `distanceFromBottom` goes negative.
    act(() => {
      handle.scroller.setContentHeight(100);
    });
    handle.update();

    expect(handle.enabled()).toBe(true);
    expect(handle.scroller.maxScrollTop).toBe(0);
    expect(handle.scroller.scrollTop).toBe(0);
  });

  it('31: re-engages when clearTranscription makes the bottom reachable', () => {
    const handle = mount();

    userScrollsBack(handle);
    expect(handle.enabled()).toBe(false);
    advance(SCROLL_SETTLE_MS + 1);

    act(() => {
      handle.scroller.setContentHeight(100);
    });

    expect(handle.enabled()).toBe(true);
    expect(handle.scroller.scrollTop).toBe(0);
    expect(handle.scroller.scrollTop).toBe(handle.scroller.maxScrollTop);
  });

  it('32: jumpToBottom re-engages AND pins inside the settle window', () => {
    const handle = mount();

    userScrollsBack(handle);
    expect(handle.enabled()).toBe(false);

    // Still inside the settle window, so the user scroll session is open and
    // the pin layout effect would decline to run. `jumpToBottom` has to close
    // the session itself and scroll directly - flipping the flag alone scrolls
    // nothing (plan section 10, T14).
    advance(SCROLL_SETTLE_MS - 100);
    act(() => {
      handle.hook().jumpToBottom();
    });

    expect(handle.enabled()).toBe(true);
    expect(handle.scroller.scrollTop).toBe(MAX_SCROLL_PX);
  });
});

describe('useAutoScroll scrollend handling', (it) => {
  it('33: a scrollend from our own pin does not discard the user gesture', () => {
    const handle = mount();

    // A gesture arms, but has not moved anything yet - the finger is down, or
    // the wheel has only just been touched.
    wheel(handle.scroller.el);
    const armedAt = performance.now();

    // In the same frame, new caption text arrives and we pin. Engines that
    // implement `scrollend` fire one for our own instant write.
    handle.update();
    expect(handle.scroller.scrollTop).toBe(handle.scroller.maxScrollTop);

    advance(PROGRAMMATIC_SCROLLEND_GRACE_MS - 10);
    scrollEnd(handle.scroller);

    // Honouring that `scrollend` would run `closeUserScrollSession`, which
    // resets the arm window - and the reader's actual scroll, a moment later,
    // would go unattributed and fail to disengage.
    //
    // (The stronger form of this case - an already-open session surviving the
    // `scrollend` - is unreachable now that `handleScroll` refuses to open a
    // session for a scroll inside the grace window and the pin effect refuses
    // to run while one is open. The armed window is what is left to protect.)
    advance(CLEAR_OF_PIN_MS - (PROGRAMMATIC_SCROLLEND_GRACE_MS - 10));
    expect(performance.now() - armedAt).toBeLessThan(USER_INPUT_ARM_MS);
    scrollTo(handle.scroller, MAX_SCROLL_PX - WELL_PAST_THRESHOLD_PX);

    expect(handle.enabled()).toBe(false);
    expect(handle.hook().getDiagnostics().userDisengagements).toBe(1);
  });

  it('34: a real scrollend outside the grace window closes the session', () => {
    const handle = mount();

    // Open a genuine session, landing inside the pin zone so we stay engaged.
    wheel(handle.scroller.el);
    scrollTo(handle.scroller, MAX_SCROLL_PX - PIN_TOLERANCE_PX);
    expect(handle.enabled()).toBe(true);

    // Past the grace window but well short of SCROLL_SETTLE_MS, so it is the
    // `scrollend` and not the settle timer that closes the session.
    const closeAfterMs = PROGRAMMATIC_SCROLLEND_GRACE_MS + 10;
    expect(closeAfterMs).toBeLessThan(SCROLL_SETTLE_MS);
    advance(closeAfterMs);
    scrollEnd(handle.scroller);

    // Session closed and the arm window reset, so the next scroll - the tail of
    // what the DOM saw as the same movement - is unattributed and inert.
    scrollTo(handle.scroller, MAX_SCROLL_PX - WELL_PAST_THRESHOLD_PX);
    expect(handle.enabled()).toBe(true);
    const diagnostics = handle.hook().getDiagnostics();
    expect(diagnostics.userDisengagements).toBe(0);
    expect(diagnostics.suppressedDisengagements).toBe(1);
  });
});

describe('useAutoScroll mount lifecycle', (it) => {
  it('35: attaches listeners once net under StrictMode', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handle = mount({ strict: true });

    // StrictMode mounts, unmounts and remounts. Had the effect cleanup not
    // removed the listeners, the second mount would leave two of each attached.
    emitRawScroll(handle.scroller, MAX_SCROLL_PX - WELL_PAST_THRESHOLD_PX);
    expect(handle.enabled()).toBe(true);
    expect(handle.hook().getDiagnostics().suppressedDisengagements).toBe(1);

    wheel(handle.scroller.el);
    scrollTo(handle.scroller, MAX_SCROLL_PX - WELL_PAST_THRESHOLD_PX);
    expect(handle.enabled()).toBe(false);
    expect(handle.hook().getDiagnostics().userDisengagements).toBe(1);

    // No orphaned settle timer once the session drains.
    advance(SCROLL_SETTLE_MS + 1);
    expect(vi.getTimerCount()).toBe(0);

    expect(
      consoleError.mock.calls.filter((call) =>
        String(call[0]).includes('not wrapped in act'),
      ),
    ).toEqual([]);
  });

  it('36: removes every listener and timer on unmount', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handle = mount();

    // Leave a settle timer pending so the cleanup has something to clear.
    userScrollsBack(handle);
    expect(handle.enabled()).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // The recorder closes over its counters, so this stays callable after the
    // component is gone and reports anything a surviving listener records.
    const getDiagnostics = handle.hook().getDiagnostics;
    const before = getDiagnostics();

    handle.unmount();
    expect(vi.getTimerCount()).toBe(0);

    // Deliberately NOT wrapped in `act`: a surviving listener would set state
    // on an unmounted tree and React would log its act warning.
    handle.scroller.emitRawScroll(MAX_SCROLL_PX - WELL_PAST_THRESHOLD_PX);
    handle.scroller.el.dispatchEvent(new WheelEvent('wheel'));
    handle.scroller.emitRawScroll(MAX_SCROLL_PX - WELL_PAST_THRESHOLD_PX);

    expect(getDiagnostics()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('useAutoScroll scope and isolation', (it) => {
  it('37: ignores a gesture that started outside the container', () => {
    const handle = mount();

    // ACCEPTED LIMITATION (plan section 10, T3): the arming listeners are
    // capture-phase but container-scoped, so a wheel that begins on a sibling -
    // surrounding page chrome, say - and is then routed to the caption region
    // by the engine never arms attribution, and the resulting scroll is
    // suppressed. Asserted here so it is a recorded decision rather than an
    // accident. Widening the listeners to `document` would fix it at the cost
    // of attributing every unrelated page gesture to the captions.
    act(() => {
      handle.sibling.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    });
    scrollTo(handle.scroller, MAX_SCROLL_PX - WELL_PAST_THRESHOLD_PX);

    expect(handle.enabled()).toBe(true);
    expect(handle.hook().getDiagnostics().suppressedDisengagements).toBe(1);
  });

  it('38: keeps two instances independent', () => {
    const transcript = mount({ label: 'iso-transcription' });
    const translation = mount({ label: 'iso-translation' });

    // Both regions publish their own counters while mounted; one shared object
    // would let whichever mounted last erase the other's numbers.
    expect(readAutoScrollDiagnostics('iso-transcription')).toBeDefined();
    expect(readAutoScrollDiagnostics('iso-translation')).toBeDefined();

    userScrollsBack(transcript);

    expect(transcript.enabled()).toBe(false);
    expect(translation.enabled()).toBe(true);
    expect(translation.scroller.scrollTop).toBe(MAX_SCROLL_PX);

    expect(transcript.hook().getDiagnostics()).toMatchObject({
      userDisengagements: 1,
      suppressedDisengagements: 0,
    });
    expect(translation.hook().getDiagnostics()).toMatchObject({
      userDisengagements: 0,
      suppressedDisengagements: 0,
      idleReengagements: 0,
    });
    expect(readAutoScrollDiagnostics('iso-transcription')).toMatchObject({
      userDisengagements: 1,
    });
    expect(readAutoScrollDiagnostics('iso-translation')).toMatchObject({
      userDisengagements: 0,
    });

    // The still-engaged region keeps following the speaker.
    act(() => {
      translation.scroller.setContentHeight(CONTENT_PX + 300);
    });
    translation.update();
    expect(translation.scroller.scrollTop).toBe(
      translation.scroller.maxScrollTop,
    );
  });
});
