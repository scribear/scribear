import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type TranslatedSegment,
  TranslationStatus,
} from '@scribear/live-translation-store';

import { TranslatedCaptionsPanel } from '#src/components/translated-captions-panel.js';

import { type FakeScroller, installFakeScroller } from '../fake-scroller.js';
import { renderWithProviders } from '../render.js';

// 1.5 lines of 48px is 72px, comfortably above the hook's 48px floor, so the
// scrollback threshold under test is 72px and a 400px scroll back clears it.
const LINE_HEIGHT_PX = 48;
const VIEWPORT_PX = 160;
const INITIAL_CONTENT_PX = 1000;
// Height one more translated segment adds to the content.
const SEGMENT_PX = 48;
// Far enough back to clear the threshold with room to spare.
const SCROLLBACK_PX = 400;
// Longer than the hook's window for treating a scroll event as its own pin, and
// longer than its settle window, so each simulated action starts from rest.
const QUIET_MS = 500;

const makeSegment = (n: number): TranslatedSegment => ({
  id: `t${n.toString()}`,
  text: `Segmento ${n.toString()}.`,
  kind: 'text',
});

/** Lets time pass on the faked clock, flushing anything React schedules. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

interface Harness {
  // Changes the caption line height, as a live user preference would.
  setLineHeight: (px: number) => void;
  // The scroll container's fake layout, driven by the test.
  scroller: FakeScroller;
  // The `role="log"` element the auto-scroll hook is wired to.
  log: HTMLElement;
  // Delivers one more translated segment: the content grows, then the panel
  // re-renders - the order a browser sees it in.
  appendSegment: () => void;
  // The jump-to-bottom control, whether or not it is currently shown.
  jumpButton: () => HTMLElement;
  // Whether the jump-to-bottom control is shown, which is the user-visible form
  // of "auto-scroll is disengaged".
  isJumpButtonVisible: () => boolean;
}

/**
 * Renders the panel over a working fake scroller, pinned to the newest caption.
 *
 * @returns Handles for driving and inspecting the panel.
 */
function mountPanel(): Harness {
  let lineHeightPx = LINE_HEIGHT_PX;
  // Held stable across renders, exactly as the Redux selector behind this prop
  // is: rebuilding it every render would make `segments` change identity on
  // every re-render and mask whether the other props reach the pin effect.
  let segments = Array.from({ length: 3 }, (_, i) => makeSegment(i));
  const panel = () => (
    <TranslatedCaptionsPanel
      segments={segments}
      status={TranslationStatus.READY}
      targetLanguage="es"
      targetLanguageLabel="Spanish"
      downloadProgress={null}
      errorMessage={null}
      wordSpacingEm={0.25}
      fontSizePx={32}
      lineHeightPx={lineHeightPx}
    />
  );

  const view = renderWithProviders(panel());
  const log = screen.getByRole('log');
  const scroller = installFakeScroller(log, {
    contentHeight: INITIAL_CONTENT_PX,
    viewportHeight: VIEWPORT_PX,
  });

  const appendSegment = () => {
    segments = [...segments, makeSegment(segments.length)];
    act(() => {
      scroller.setContentHeight(scroller.contentHeight + SEGMENT_PX);
      view.rerender(panel());
    });
  };

  /**
   * Simulates the reader bumping the caption size. The segments are untouched -
   * only the metrics change - so this reaches the pin effect only if those
   * metrics are dependencies of it.
   */
  const setLineHeight = (px: number) => {
    lineHeightPx = px;
    act(() => {
      // Bigger text reflows to taller content, so the bottom moves.
      scroller.setContentHeight(scroller.contentHeight + SEGMENT_PX);
      view.rerender(panel());
    });
  };

  // Queried including hidden elements - and without a name, because the
  // accessible name of a hidden element computes to the empty string. The panel
  // renders exactly one button.
  const jumpButton = () => screen.getByRole('button', { hidden: true });

  // The first render happened before the scroller existed, so deliver one
  // segment to get the panel pinned the way a live session would, then let the
  // clock move on so nothing that follows is mistaken for that pin.
  appendSegment();
  advance(QUIET_MS);

  return {
    setLineHeight,
    scroller,
    log,
    appendSegment,
    jumpButton,
    isJumpButtonVisible: () =>
      globalThis.getComputedStyle(jumpButton()).visibility !== 'hidden',
  };
}

/** Scrolls back the way a reader does: an input gesture, then the scroll. */
function userScrollsBack(harness: Harness, toOffset: number): void {
  act(() => {
    fireEvent.wheel(harness.log);
    harness.scroller.scrollTo(toOffset);
  });
}

describe('TranslatedCaptionsPanel auto-scroll', () => {
  beforeEach(() => {
    // `performance` is faked too: the hook times its attribution windows with
    // `performance.now()`, and real elapsed time between two statements in a
    // test is far shorter than any of them.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows new translated segments', () => {
    const { scroller, appendSegment, isJumpButtonVisible } = mountPanel();

    appendSegment();

    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(isJumpButtonVisible()).toBe(false);
  });

  it('keeps following when the viewport clamps the offset against grown content', () => {
    // The clamp-vs-growth race: the engine clamps the offset down against the
    // old content height, then new captions land before the scroll event is
    // delivered, so the handler sees a large distance from the bottom that no
    // user created. Nothing armed it, so it must not disengage.
    const { scroller, appendSegment, isJumpButtonVisible } = mountPanel();

    act(() => {
      scroller.clampThenGrow(200, 300);
    });
    appendSegment();

    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(isJumpButtonVisible()).toBe(false);
  });

  it('keeps following through sub-pixel scroll dither', () => {
    // A resting scroller reporting fractional offsets a hair outside the pin
    // tolerance. No gesture, so it is suppressed rather than acted on.
    const { scroller, appendSegment, isJumpButtonVisible } = mountPanel();

    act(() => {
      scroller.emitRawScroll(scroller.maxScrollTop - 8.91);
      scroller.emitRawScroll(scroller.maxScrollTop - 8.66);
    });
    appendSegment();

    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(isJumpButtonVisible()).toBe(false);
  });

  it('stops following when the reader wheels back past the threshold', () => {
    const harness = mountPanel();
    const { scroller, appendSegment, isJumpButtonVisible } = harness;

    userScrollsBack(harness, scroller.maxScrollTop - SCROLLBACK_PX);
    const restingOffset = scroller.scrollTop;
    appendSegment();

    expect(scroller.scrollTop).toBe(restingOffset);
    expect(isJumpButtonVisible()).toBe(true);
  });

  it('keeps following after a tap that scrolls nothing', () => {
    // A gesture only arms; on its own it must never stop the captions. The
    // caption region is focusable, so tapping it is a documented affordance.
    const { scroller, log, appendSegment, isJumpButtonVisible } = mountPanel();

    act(() => {
      fireEvent.pointerDown(log);
    });
    for (let i = 0; i < 5; i += 1) {
      appendSegment();
      expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
      advance(QUIET_MS);
    }

    expect(isJumpButtonVisible()).toBe(false);
  });

  it('lets the reader stay scrolled back while new segments arrive', () => {
    // The new capability. Before this the panel yanked every reader back to the
    // newest caption on every segment.
    const harness = mountPanel();
    const { scroller, log, appendSegment } = harness;

    userScrollsBack(harness, scroller.maxScrollTop - SCROLLBACK_PX);
    const restingOffset = scroller.scrollTop;

    appendSegment();
    advance(QUIET_MS);
    appendSegment();
    advance(QUIET_MS);
    appendSegment();

    expect(scroller.scrollTop).toBe(restingOffset);
    // The captions themselves still arrive - only the scrolling stopped.
    expect(log).toHaveTextContent('Segmento 6.');
  });

  it('follows again once the reader returns to the bottom', () => {
    const harness = mountPanel();
    const { scroller, appendSegment, isJumpButtonVisible } = harness;

    userScrollsBack(harness, scroller.maxScrollTop - SCROLLBACK_PX);
    expect(isJumpButtonVisible()).toBe(true);

    advance(QUIET_MS);
    userScrollsBack(harness, scroller.maxScrollTop);
    advance(QUIET_MS);
    appendSegment();

    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(isJumpButtonVisible()).toBe(false);
  });

  it('offers a jump-to-bottom control that returns the reader to the newest caption', () => {
    const harness = mountPanel();
    const { scroller, appendSegment, jumpButton, isJumpButtonVisible } =
      harness;

    // Hidden while engaged, and hidden from assistive technology with it.
    expect(isJumpButtonVisible()).toBe(false);
    expect(
      screen.queryByRole('button', { name: /jump to latest/i }),
    ).toBeNull();

    userScrollsBack(harness, scroller.maxScrollTop - SCROLLBACK_PX);
    expect(isJumpButtonVisible()).toBe(true);
    // Named for the translation, not the transcript: on the kiosk and client
    // apps both regions are on screen at once, and two controls sharing one
    // accessible name give a screen-reader user no way to tell them apart.
    expect(
      screen.getByRole('button', { name: 'Jump to latest translation' }),
    ).toBeInTheDocument();

    act(() => {
      fireEvent.click(jumpButton());
    });

    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(isJumpButtonVisible()).toBe(false);

    advance(QUIET_MS);
    appendSegment();
    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
  });

  it('re-pins when the reader changes the caption size mid-pause', () => {
    // The caption metrics are dependencies of the pin, not just of the
    // scrollback threshold: changing the font reflows the content, so the
    // bottom moves. Without them the panel sits a line off the bottom until
    // the next segment happens to arrive - which, during a pause in speech,
    // can be a long time.
    const { scroller, setLineHeight, isJumpButtonVisible } = mountPanel();

    setLineHeight(96);

    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(isJumpButtonVisible()).toBe(false);
  });

  it('pins instantly rather than animating', () => {
    // A smooth scroll is re-targeted by every interim update, so it never
    // settles; it only adds lag.
    const { scroller, appendSegment } = mountPanel();

    appendSegment();

    expect(scroller.scrollToCalls.length).toBeGreaterThan(0);
    expect(new Set(scroller.scrollToCalls)).toEqual(new Set(['instant']));
  });
});
