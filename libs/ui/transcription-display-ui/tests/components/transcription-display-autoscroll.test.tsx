/**
 * Component-level auto-scroll behaviour for the caption container.
 *
 * The hook itself is covered exhaustively in `tests/hooks/*`; this file asserts
 * the wiring the user actually meets - the CSS rules that keep engine-driven
 * scroll adjustments out of the way, the jump-to-bottom control, and the fact
 * that touching the caption region (its documented focus affordance) does not
 * stop the captions following the speaker.
 *
 * See 20260831-FixAutoScroll-PLAN.md section 6.3.
 */
import { useState } from 'react';

import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ActiveSection,
  TranscriptionSection,
} from '@scribear/transcription-content-store';

import { TranscriptionDisplayContainer } from '#src/components/transcription-display-container.js';

import { installFakeScroller } from '../fake-scroller.js';
import { renderWithProviders } from '../render.js';

const LINE_HEIGHT_PX = 40;
// max(MIN_SCROLLBACK_PX, lineHeightPx * 1.5) = max(48, 60) = 60
const SCROLLBACK_THRESHOLD_PX = 60;

const commitedSections: TranscriptionSection[] = [
  { id: 's1', text: 'Hello world.' },
];
const activeSection: ActiveSection = {
  id: 'active',
  sequences: [{ id: 'seq1', text: ['partial ', 'interim'] }],
};

function renderContainer(inProgressTranscriptionText = ' live') {
  return renderWithProviders(
    <TranscriptionDisplayContainer
      commitedSections={commitedSections}
      activeSection={activeSection}
      inProgressTranscriptionText={inProgressTranscriptionText}
      wordSpacingEm={0}
      fontSizePx={32}
      lineHeightPx={LINE_HEIGHT_PX}
      getBoundedDisplayPreferences={() => ({
        verticalPositionPx: 0,
        numDisplayLines: 8,
      })}
    />,
  );
}

/**
 * Renders the container inside a harness that owns the interim text, so a test
 * can push transcript updates through a real re-render. RTL's `rerender`
 * replaces the whole tree and would drop the theme and height providers.
 */
function renderStreamingContainer() {
  const control: { emit: (text: string) => void } = {
    emit: () => {
      throw new Error('harness not mounted');
    },
  };

  const Harness = () => {
    const [text, setText] = useState(' live');
    control.emit = setText;
    return (
      <TranscriptionDisplayContainer
        commitedSections={commitedSections}
        activeSection={activeSection}
        inProgressTranscriptionText={text}
        wordSpacingEm={0}
        fontSizePx={32}
        lineHeightPx={LINE_HEIGHT_PX}
        getBoundedDisplayPreferences={() => ({
          verticalPositionPx: 0,
          numDisplayLines: 8,
        })}
      />
    );
  };

  const result = renderWithProviders(<Harness />);
  return {
    ...result,
    emitTranscript: (text: string) => {
      control.emit(text);
    },
  };
}

/** The scroll container, with a working scroller model installed over jsdom. */
function setUpScroller() {
  const log = screen.getByRole('log');
  const scroller = installFakeScroller(log, {
    contentHeight: 2000,
    viewportHeight: 320,
  });
  // Mounting already ran the pin effect against a height-less jsdom element,
  // so start the test from a known pinned position.
  act(() => {
    scroller.scrollTo(scroller.maxScrollTop);
  });
  return { log, scroller };
}

/** Scrolls back the way a user would: a real gesture, then the movement. */
function userScrollsBack(
  log: HTMLElement,
  scroller: ReturnType<typeof installFakeScroller>,
  distance: number,
) {
  act(() => {
    fireEvent.wheel(log);
    scroller.scrollTo(scroller.maxScrollTop - distance);
  });
}

/**
 * The control is hidden with `visibility: hidden` rather than unmounted, so it
 * is always in the DOM and presence proves nothing - assert with `toBeVisible`.
 * It is fetched by attribute rather than by role and name because a
 * `visibility: hidden` element has no accessible name to match on, which is
 * the point: while auto-scroll is following, the control is gone from the
 * accessibility tree too, not merely invisible.
 */
function jumpButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>(
    'button[aria-label="Jump to latest transcription"]',
  );
  if (button === null) throw new Error('jump-to-bottom button is not rendered');
  return button;
}

/** MUI serialises `sx` into an emotion class, so assert on the emitted CSS. */
function emittedCss(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('');
}

describe('TranscriptionDisplayContainer auto-scroll', (it) => {
  it('keeps engine scroll adjustments out of the way with CSS', () => {
    renderContainer();

    const css = emittedCss().replace(/\s/g, '');
    // Blink/Gecko scroll anchoring would fight the pin-to-bottom.
    expect(css).toContain('overflow-anchor:none');
    // No overscroll chaining to the page; damped rubber-band on iOS.
    expect(css).toContain('overscroll-behavior:contain');
  });

  it('hides the jump-to-bottom control while it is still following', () => {
    renderContainer();
    setUpScroller();

    expect(jumpButton()).not.toBeVisible();
    // And out of the accessibility tree, not just invisible - a screen reader
    // must not offer "jump to latest" when it is already showing the latest.
    expect(
      screen.queryByRole('button', { name: 'Jump to latest transcription' }),
    ).toBeNull();
  });

  it('offers the jump-to-bottom control once the reader scrolls back', () => {
    renderContainer();
    const { log, scroller } = setUpScroller();

    userScrollsBack(log, scroller, SCROLLBACK_THRESHOLD_PX + 400);

    expect(jumpButton()).toBeVisible();
    // Now it is exposed to assistive technology as well.
    expect(
      screen.getByRole('button', { name: 'Jump to latest transcription' }),
    ).toBeVisible();
  });

  it('returns to the bottom when the jump-to-bottom control is used', () => {
    renderContainer();
    const { log, scroller } = setUpScroller();
    userScrollsBack(log, scroller, SCROLLBACK_THRESHOLD_PX + 400);

    act(() => {
      fireEvent.click(jumpButton());
    });

    // Both halves matter: the flag flips *and* the view actually moves. An
    // earlier draft flipped the flag while the pin effect declined to run,
    // leaving the reader stranded with the button switched off.
    expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    expect(jumpButton()).not.toBeVisible();
  });

  it('returns to the bottom even when tapped during the settle window', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      renderContainer();
      const { log, scroller } = setUpScroller();
      userScrollsBack(log, scroller, SCROLLBACK_THRESHOLD_PX + 400);

      // Still inside SCROLL_SETTLE_MS, so the user scroll session is open.
      act(() => {
        vi.advanceTimersByTime(100);
      });
      act(() => {
        fireEvent.click(jumpButton());
      });

      expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps following the speaker after a tap on the caption region', () => {
    const { emitTranscript } = renderStreamingContainer();
    const { log, scroller } = setUpScroller();

    // The region is `tabIndex={0}` so keyboard and AT users can reach it, so
    // tapping it is expected behaviour - not a request to stop the captions.
    // An earlier draft of the hook treated any input gesture as a scrollback
    // and froze the display here, which is the bug this whole change is about.
    act(() => {
      fireEvent.pointerDown(log);
      fireEvent.touchStart(log);
    });

    for (let update = 1; update <= 5; update += 1) {
      act(() => {
        scroller.setContentHeight(2000 + update * 100);
        emitTranscript(`chunk ${update.toString()} `.repeat(update));
      });
      expect(scroller.scrollTop).toBe(scroller.maxScrollTop);
    }

    expect(jumpButton()).not.toBeVisible();
  });
});
