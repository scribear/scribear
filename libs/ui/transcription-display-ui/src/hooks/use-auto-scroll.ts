import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import {
  type AutoScrollDiagnostics,
  createAutoScrollDiagnostics,
} from './auto-scroll-debug.js';

/**
 * Distance from the bottom (px) within which the view counts as pinned.
 * Small, but never zero: `scrollTop` is a fractional double, and browser zoom
 * or a non-integral devicePixelRatio put an exact match out of reach.
 */
export const PIN_TOLERANCE_PX = 8;

/**
 * Floor for how far a user must scroll back before we stop following the
 * speaker. Scaled up with the caption line height by the caller, so one
 * accidental nudge on a large-type kiosk display does not disengage.
 * Deliberately far larger than PIN_TOLERANCE_PX - the gap between the two is
 * hysteresis, and without it the state flaps at the boundary.
 */
export const MIN_SCROLLBACK_PX = 48;

/** Multiple of the caption line height used as the scrollback threshold. */
const SCROLLBACK_LINES = 1.5;

/**
 * How long after an input gesture a scroll event is still that gesture's doing.
 * Covers the gap between `touchstart` and the drag actually moving. `touchmove`
 * re-arms, so a slow drag stays attributed however long the finger rests first.
 */
export const USER_INPUT_ARM_MS = 400;

/**
 * Quiet period after the last scroll event before a user scroll session is
 * considered finished. It has to outlast iOS momentum, which keeps firing
 * scroll events for seconds after `touchend`, and it stands in for `scrollend`
 * on engines that do not implement it (Safari before 18.2).
 */
export const SCROLL_SETTLE_MS = 300;

/*
 * Note for anyone tuning the two constants above. They measure different gaps:
 * arming covers gesture-to-first-scroll latency, settling covers silence after
 * the last scroll. USER_INPUT_ARM_MS being the larger of the two does NOT mean
 * an expired session can be revived by the original arm - `closeUserScrollSession`
 * wipes the arm precisely so that a scroll arriving after 300ms of silence is
 * treated as the engine's, not the user's. What the arm actually covers is a
 * gesture whose first scroll is slow to arrive. It does mean the settle
 * boundary is only observable once the arm has expired, which is why the tests
 * open their session well before probing it.
 */

/**
 * Window after our own instant scroll in which a scroll event or `scrollend` is
 * assumed to be ours rather than the reader's.
 *
 * Generous on purpose. The pin is issued from a layout effect but its `scroll`
 * event is delivered in a later task, and on a kiosk decoding audio the gap can
 * be far more than a frame; too short a window and a main-thread stall lets the
 * pin's own scroll open a user session, blocking the next pin. Being generous
 * is safe because the scroll-attribution check also requires the event to be at
 * the bottom, and a reader who really is at the bottom gets re-engaged by the
 * next branch anyway. For `scrollend`, over-matching merely defers the session
 * close to the settle timer.
 */
export const PROGRAMMATIC_SCROLLEND_GRACE_MS = 250;

/**
 * Floor on how often a presence event may restart the idle timer.
 * `pointermove` fires up to ~120/s; a clearTimeout/setTimeout pair per event is
 * cheap but pointless against a multi-minute deadline.
 */
export const IDLE_ACTIVITY_THROTTLE_MS = 5_000;

/**
 * Keys that scroll. A bare `keydown` filter would arm on Ctrl, Shift and every
 * character key, which is how a modifier press ends up looking like intent.
 */
const NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

/** Input events that arm the attribution window. */
const USER_INPUT_EVENTS = [
  'pointerdown',
  'touchstart',
  'touchmove',
  'wheel',
  'keydown',
] as const;

/**
 * Events that count as "someone is still here" while auto-scroll is disengaged.
 * Deliberately a *wider* set than USER_INPUT_EVENTS, and the asymmetry is the
 * point: arming needs narrow evidence, because a false positive stops the
 * captions; idle detection needs broad evidence, because a false positive
 * yanks a present reader's place. Hover and focus are useless as intent but
 * excellent as presence, so they belong here and nowhere else.
 */
const IDLE_ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'touchstart',
  'touchmove',
  'wheel',
  'keydown',
  'focusin',
] as const;

/**
 * Return value of `useAutoScroll`, containing refs and handlers for wiring up
 * the scroll container.
 */
export interface UseAutoScrollResult {
  isAutoScrollEnabled: boolean;
  textContainerRef: React.RefObject<HTMLElement | null>;
  handleScroll: () => void;
  // Re-engage and pin in one call. Use this for the jump-to-bottom control;
  // flipping the flag alone is not enough (see the comment on the function).
  jumpToBottom: () => void;
  // Current diagnostic counters, for tests and the e2e soak.
  getDiagnostics: () => AutoScrollDiagnostics;
}

/** Tuning knobs supplied by the caller. */
export interface UseAutoScrollOptions {
  // Caption line height in px. Scales the scrollback threshold to the text
  // size so the gesture required is proportionate on a 96px kiosk display.
  lineHeightPx?: number;
  // Distinguishes this instance in the debug diagnostics. Two caption regions
  // (transcription and translated captions) are mounted at once on the kiosk.
  label?: string;
  // Re-engage auto-scroll after this many ms with no scroll and no sign of a
  // reader, once the user has scrolled back. `null` disables it and the view
  // stays where they left it. A deliberate per-app decision, not a default to
  // inherit unthinkingly - on a touch device, which has no hover to signal
  // presence, this will eventually return a reading user to the bottom.
  idleReengageMs?: number | null;
}

/**
 * Keeps a scrollable caption container pinned to the newest text, and steps
 * aside when the reader scrolls back.
 *
 * Auto-scroll is only ever disengaged by a scroll event attributable to a real
 * input gesture on the container. Everything else that moves `scrollTop`
 * without a user - viewport-resize clamps measured against grown content,
 * sub-pixel dither, a stale iOS scroll-position replica, rubber-band settle,
 * smooth-scroll retargeting, scroll anchoring - reaches the handler
 * unattributed and is ignored. Arriving at the bottom always re-engages,
 * whoever put it there, so the state can never get stuck off.
 *
 * Note the asymmetry between arming and opening: an input gesture alone only
 * arms. A tap that produces no scroll must not stop us following the speaker.
 *
 * @param dependencies Values that trigger a re-pin when auto-scroll is engaged.
 *   Must keep a CONSTANT LENGTH across renders. They are spread into an effect
 *   dependency array, and React compares only the shared prefix when lengths
 *   differ - it logs a development-only error and then skips the effect, so a
 *   caller whose array grows would silently stop re-pinning.
 * @param options Tuning knobs; see {@link UseAutoScrollOptions}.
 * @returns Refs and handlers to wire up to the scroll container.
 */
export const useAutoScroll = (
  dependencies: unknown[],
  {
    lineHeightPx = 0,
    label = 'transcription',
    idleReengageMs = null,
  }: UseAutoScrollOptions = {},
): UseAutoScrollResult => {
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  const textContainerRef = useRef<HTMLElement>(null);

  // `performance.now()`, not `Date.now()`: a kiosk runs for days and an NTP
  // step must not make a timer fire early or never.
  const armedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastProgrammaticScrollAtRef = useRef(Number.NEGATIVE_INFINITY);
  const userScrollActiveRef = useRef(false);
  // Mirrors `isAutoScrollEnabled` for use inside event handlers, so a burst of
  // scroll events in one batch sees the transition rather than stale state.
  // Without it, a continuous scrollback counts one "disengagement" per frame
  // and re-arms the idle timer per frame.
  const engagedRef = useRef(true);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIdleResetAtRef = useRef(Number.NEGATIVE_INFINITY);
  // Latest `restartIdleTimer`, so the presence listener can call it without the
  // listener effect depending on it. See the effect that maintains it.
  const restartIdleTimerRef = useRef<() => void>(() => undefined);
  // Length of the caller's dependency array on the previous render; see the
  // check in the pin effect.
  const dependencyCountRef = useRef<number | null>(null);

  // A lazy `useState` initialiser, not a ref written during render: it gives
  // one stable recorder per mounted instance without touching a ref while
  // rendering. Disposed by the listener effect's cleanup.
  const [diagnostics] = useState(() => createAutoScrollDiagnostics(label));

  const scrollbackThresholdPx = Math.max(
    MIN_SCROLLBACK_PX,
    lineHeightPx * SCROLLBACK_LINES,
  );

  const scrollToBottom = useCallback(() => {
    const container = textContainerRef.current;
    if (!container) return;
    lastProgrammaticScrollAtRef.current = performance.now();
    // Load-bearing for `isOwnScroll`, not only for latency: an instant scroll
    // updates `scrollTop` to the bottom synchronously, so the pin's own echo
    // always reports distance ~0 and is recognised as ours. Switching this back
    // to `smooth` (or to `scrollIntoView`) would break that half of the guard,
    // and the echo could open a user session and block the next pin.
    //
    // `scrollTo` with an explicit `instant`, not `scrollIntoView` and not a
    // bare `scrollTop =`. A smooth animation is re-targeted on every interim
    // update so it never settles - it only adds lag and, on iOS, races the
    // thread that actually owns the offset. `scrollIntoView` additionally
    // scrolls every scrollable ancestor, which the kiosk's split-pane layout
    // does not want. A bare `scrollTop =` would inherit a CSS
    // `scroll-behavior: smooth` if one ever appeared; `instant` cannot.
    // An over-large `top` is clamped to the maximum by the engine.
    container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
  }, []);

  /**
   * Ends an open scroll session but leaves the gesture's arm window intact, so
   * a drag that is still under way keeps being attributed to the user. Used
   * when the view reaches the bottom mid-gesture: the pin must be allowed to
   * run again immediately, but the reader has not finished scrolling.
   */
  const endUserScrollSession = useCallback(() => {
    userScrollActiveRef.current = false;
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  /** Ends the session and forgets the gesture entirely. */
  const closeUserScrollSession = useCallback(() => {
    endUserScrollSession();
    armedAtRef.current = Number.NEGATIVE_INFINITY;
  }, [endUserScrollSession]);

  const extendUserScrollSession = useCallback(() => {
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(
      closeUserScrollSession,
      SCROLL_SETTLE_MS,
    );
  }, [closeUserScrollSession]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    // Reset alongside the timer, so the presence throttle never carries a
    // stale stamp into the next disengaged period and swallows its first
    // presence event.
    lastIdleResetAtRef.current = Number.NEGATIVE_INFINITY;
  }, []);

  /** Re-engages, keeping `engagedRef` in step with the rendered state. */
  const engage = useCallback(() => {
    engagedRef.current = true;
    clearIdleTimer();
    setIsAutoScrollEnabled(true);
  }, [clearIdleTimer]);

  /**
   * Arms (or re-arms) the idle re-engage timer. Only meaningful while
   * disengaged: the disengage path starts it, and every subsequent scroll or
   * presence event pushes the deadline back out.
   */
  const restartIdleTimer = useCallback(() => {
    if (idleReengageMs === null) return;
    // `arm` is a local so it can re-arm itself without the callback appearing
    // in its own dependency list.
    const arm = () => {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        // Never yank someone whose finger is still on the glass.
        //
        // Unreachable at the shipped configuration, and deliberately kept: any
        // scroll both opens the session and pushes this deadline out by
        // `idleReengageMs`, while the session closes SCROLL_SETTLE_MS later, so
        // with a multi-minute delay the deadline can never elapse while a
        // session is open. The branch only runs when `idleReengageMs` is
        // shorter than SCROLL_SETTLE_MS. It stays because `idleReengageMs` is
        // caller-supplied and a short value must not yank a finger mid-drag.
        if (userScrollActiveRef.current) {
          arm();
          return;
        }
        // Nor anyone whose keyboard or screen-reader focus is parked inside the
        // captions: that is someone reading, and moving the view out from under
        // them is the WCAG 2.2.2 concern this timer raises. Note this is
        // necessary but not sufficient on iOS - VoiceOver's cursor is not DOM
        // focus, so a VoiceOver reader can still be here without `activeElement`
        // saying so. Real-device confirmation is still owed.
        const container = textContainerRef.current;
        if (container?.contains(document.activeElement)) {
          arm();
          return;
        }
        diagnostics.recordIdleReengage();
        closeUserScrollSession();
        // Deferred by `idleReengageMs` - minutes in every shipped app - so
        // this is nothing like a synchronous set-state during an effect.
        engage();
        // The pin itself is left to the layout effect: `isAutoScrollEnabled`
        // has just changed, so it is about to run anyway, and routing through
        // it keeps one code path responsible for the scroll offset.
      }, idleReengageMs);
    };
    arm();
  }, [idleReengageMs, closeUserScrollSession, engage, diagnostics]);

  const handleScroll = useCallback(() => {
    const container = textContainerRef.current;
    if (!container) return;

    const now = performance.now();
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    // Our own pin also emits a scroll event, and without this a tap that
    // produced no scroll would arm the window, the next pin would land inside
    // it, and we would attribute our own scroll to the user - opening a session
    // that blocks the pin after that. The "tap freezes the captions" bug in
    // another hat.
    //
    // Both halves are needed. The time window alone is too blunt: pins happen
    // several times a second, so it would swallow the first event of a genuine
    // scrollback that merely began soon after one. Requiring the event to be
    // *at the bottom* makes it exact rather than heuristic - the pin only ever
    // targets the bottom, so an event anywhere else cannot be ours.
    const isOwnScroll =
      distanceFromBottom <= PIN_TOLERANCE_PX &&
      now - lastProgrammaticScrollAtRef.current <
        PROGRAMMATIC_SCROLLEND_GRACE_MS;

    // A scroll event is the user's if it continues an open session (iOS
    // momentum) or lands inside the window an input gesture armed. This is the
    // only place a session opens - an input event on its own only arms.
    if (
      !isOwnScroll &&
      (userScrollActiveRef.current ||
        now - armedAtRef.current < USER_INPUT_ARM_MS)
    ) {
      userScrollActiveRef.current = true;
      extendUserScrollSession();
    }

    if (distanceFromBottom <= PIN_TOLERANCE_PX) {
      // At the bottom - follow the speaker again, whoever scrolled us here.
      // Deliberately ungated: this is the self-healing path, and it is what
      // stops a false disengage from being permanent. React bails out when the
      // value is unchanged (`Object.is`), so the common case costs no render.
      //
      // The session has to end here too. The pin effect declines to run while
      // one is open, so leaving it open after a reader scrolls back to the
      // bottom would stop the captions following for the rest of the settle
      // window - the very symptom this hook exists to prevent, just
      // self-healing instead of permanent. The arm survives, so a drag still
      // under way keeps being attributed and can scroll away again.
      endUserScrollSession();
      engage();
      return;
    }

    // Below this line we would disengage, and only a real gesture may do that.
    if (!userScrollActiveRef.current) {
      diagnostics.recordSuppressed(distanceFromBottom);
      return;
    }

    // A scroll the *user* made means they are still reading, so push the idle
    // deadline back out. Deliberately not done for unattributed scrolls: a
    // resize clamp on a rotating kiosk is not evidence of a reader, and
    // treating it as one would defer the idle re-engage indefinitely.
    if (idleTimerRef.current !== null) restartIdleTimer();

    if (distanceFromBottom > scrollbackThresholdPx && engagedRef.current) {
      engagedRef.current = false;
      diagnostics.recordUserDisengage(distanceFromBottom);
      setIsAutoScrollEnabled(false);
      restartIdleTimer();
    }
  }, [
    extendUserScrollSession,
    endUserScrollSession,
    engage,
    scrollbackThresholdPx,
    restartIdleTimer,
    diagnostics,
  ]);

  /**
   * Re-engages and pins. The jump-to-bottom control must call this rather than
   * setting the flag, because the pin effect declines to run while a user
   * scroll session is open - a tap on the button inside the settle window
   * would otherwise flip the flag and scroll nothing.
   */
  const jumpToBottom = useCallback(() => {
    closeUserScrollSession();
    engage();
    // Pinned explicitly as well as via the effect. The effect only runs if
    // `isAutoScrollEnabled` actually changed, and this must work even when it
    // did not. The second scroll is a no-op once already at the bottom.
    scrollToBottom();
  }, [closeUserScrollSession, engage, scrollToBottom]);

  const getDiagnostics = useCallback(
    () => diagnostics.snapshot(),
    [diagnostics],
  );

  // Listeners are attached imperatively rather than returned as props: it keeps
  // the call site to one `onScroll`, and lets these be capture-phase (so a
  // gesture starting on a child still counts) and passive (so they can never
  // delay scrolling on a touch device). A layout effect, not an effect, so the
  // listeners exist before the first pin can run - under `useEffect` there is a
  // window on first mount where a gesture would go unrecorded.
  useLayoutEffect(() => {
    const container = textContainerRef.current;
    if (!container) return;

    const armUserIntent = (event: Event) => {
      if (
        event.type === 'keydown' &&
        !NAVIGATION_KEYS.has((event as KeyboardEvent).key)
      ) {
        return;
      }
      armedAtRef.current = performance.now();
    };

    // Presence, not intent (see IDLE_ACTIVITY_EVENTS). Throttled because
    // `pointermove` fires far faster than a multi-minute deadline needs.
    const noteReaderPresent = () => {
      if (idleTimerRef.current === null) return;
      const now = performance.now();
      if (now - lastIdleResetAtRef.current < IDLE_ACTIVITY_THROTTLE_MS) return;
      lastIdleResetAtRef.current = now;
      restartIdleTimerRef.current();
    };

    const handleScrollEnd = () => {
      // Our own instant write emits `scrollend` on some engines. Letting that
      // close a session would drop the rest of a momentum ramp on the floor.
      if (
        performance.now() - lastProgrammaticScrollAtRef.current <
        PROGRAMMATIC_SCROLLEND_GRACE_MS
      ) {
        return;
      }
      closeUserScrollSession();
    };

    // Registered here, not at creation, so it is symmetric with the dispose
    // below and survives StrictMode's mount/unmount/remount.
    diagnostics.register();

    const options = { capture: true, passive: true } as const;
    for (const type of USER_INPUT_EVENTS) {
      container.addEventListener(type, armUserIntent, options);
    }
    for (const type of IDLE_ACTIVITY_EVENTS) {
      container.addEventListener(type, noteReaderPresent, options);
    }
    // `scrollend` closes the session promptly where supported (Chrome 114+,
    // Firefox 109+, Safari 18.2+). The settle timer is the fallback everywhere
    // else, so no feature detection is needed - whichever fires first wins.
    container.addEventListener('scrollend', handleScrollEnd);

    const activeDiagnostics = diagnostics;
    return () => {
      for (const type of USER_INPUT_EVENTS) {
        container.removeEventListener(type, armUserIntent, options);
      }
      for (const type of IDLE_ACTIVITY_EVENTS) {
        container.removeEventListener(type, noteReaderPresent, options);
      }
      container.removeEventListener('scrollend', handleScrollEnd);
      closeUserScrollSession();
      clearIdleTimer();
      activeDiagnostics.dispose();
    };
  }, [closeUserScrollSession, clearIdleTimer, diagnostics]);

  // Keeps the presence listener reaching the current `restartIdleTimer` without
  // taking it as a dependency, and re-arms the deadline when `idleReengageMs`
  // changes while disengaged.
  //
  // Both halves matter. If the listener effect depended on `restartIdleTimer`,
  // changing the delay would tear down and rebuild every listener, and that
  // effect's cleanup closes an open user scroll session - silently
  // de-attributing a reader who happened to be mid-drag when the prop changed.
  useLayoutEffect(() => {
    restartIdleTimerRef.current = restartIdleTimer;
    if (engagedRef.current) return;
    // Drop the timer armed with the previous delay before re-arming. This has
    // to be explicit: `restartIdleTimer` returns early when `idleReengageMs` is
    // `null`, so it never reaches its own clear - and a caller switching the
    // feature off mid-session would otherwise still be yanked to the bottom by
    // the deadline they just disabled.
    clearIdleTimer();
    restartIdleTimer();
  }, [restartIdleTimer, clearIdleTimer]);

  // Layout effect, not effect: pin in the same frame the new text lays out,
  // before paint. Under `useEffect` the browser gets a frame in which the
  // content has grown but the scroll has not moved.
  useLayoutEffect(() => {
    // The caller's array is spread into this effect's dependencies, and React
    // compares only the shared prefix when the length changes - it logs a
    // development-only message and then SKIPS the effect, so re-pinning would
    // stop silently in production. Say so in terms a caller can act on.
    if (
      dependencyCountRef.current !== null &&
      dependencyCountRef.current !== dependencies.length
    ) {
      console.error(
        `useAutoScroll: the \`dependencies\` array changed length ` +
          `(${dependencyCountRef.current.toString()} -> ${dependencies.length.toString()}). ` +
          'It must be constant-length across renders, or auto-scroll will stop ' +
          'following new content.',
      );
    }
    dependencyCountRef.current = dependencies.length;

    if (!isAutoScrollEnabled) return;
    // Never fight a scroll actually in flight. Note this tests the *active*
    // session, not merely armed intent - a tap must not stop the captions.
    if (userScrollActiveRef.current) return;
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [...dependencies, isAutoScrollEnabled, scrollToBottom]);

  return {
    isAutoScrollEnabled,
    textContainerRef,
    handleScroll,
    jumpToBottom,
    getDiagnostics,
  };
};
