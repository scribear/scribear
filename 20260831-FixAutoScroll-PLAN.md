# Fix auto-scroll / scrollback detection across all browser configurations

**Date:** 2026-08-31
**Component:** `libs/ui/transcription-display-ui` (shared by kiosk-webapp, client-webapp, standalone-webapp)
**Secondary:** `libs/ui/live-translation-ui`
**Status:** plan, not yet implemented. Revision 3 — revision 2 folded in the adversarial review (§10); revision 3 adds idle re-engage after scrollback (§5.4).

---

## 1. Symptom

Rarely, and non-deterministically, the caption view behaves as though the user
scrolled back through the transcript when no such interaction occurred:
auto-scroll switches off, the "Jump to latest transcription" button appears, and
new transcript text stops being followed. Nothing re-engages on its own, so the
display stays frozen until someone taps the button.

On a kiosk this is the worst possible failure: the display is often unattended,
and the room has no idea the captions stopped following the speaker.

---

## 2. How it works today

One implementation, shared by all three caption apps:

- `libs/ui/transcription-display-ui/src/hooks/use-auto-scroll.ts`
- wired in `libs/ui/transcription-display-ui/src/components/transcription-display-container.tsx:110` (hook) and `:143` (scroll container)
- consumers: `apps/kiosk-webapp/src/app/root.tsx:261`, `apps/client-webapp/src/app/root.tsx:254`, `apps/standalone-webapp/src/app/root.tsx:206`

```ts
// use-auto-scroll.ts (current)
const scrollToBottom = () => {
  textBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
};

const handleScroll = () => {
  const container = textContainerRef.current;
  if (!container) return;

  const { scrollHeight, scrollTop, clientHeight } = container;

  const isScrollingUp = scrollTop < lastScrollTopRef.current;          // (A)
  lastScrollTopRef.current = scrollTop;

  const isNearBottom = scrollHeight - scrollTop - clientHeight < 10;   // (B)

  if (isScrollingUp && !isNearBottom) {
    setIsAutoScrollEnabled(false);
  } else if (!isScrollingUp && isNearBottom) {
    setIsAutoScrollEnabled(true);
  }
};

useEffect(() => {
  if (isAutoScrollEnabled) scrollToBottom();
}, [...dependencies, isAutoScrollEnabled]);
```

The effect dependencies are
`[commitedSections, activeSection, inProgressTranscriptionText, containerHeightPx, displayHeightPx]`,
so `scrollToBottom` is re-issued on **every interim transcript update** — several
times a second during speech.

### The design flaw

`handleScroll` cannot tell *who* moved the scroll position. A finger drag, a
wheel tick, the hook's own smooth-scroll animation and the browser's own layout
adjustments all arrive as the same `scroll` event. The code infers user intent
from one signal — **did `scrollTop` go down** — gated behind **are we more than
10px from the bottom**. Both are unsound.

---

## 3. Root-cause analysis

### 3.1 Guard (B) is inert during exactly the period that matters

`behavior: 'smooth'` is an animation lasting a few hundred milliseconds. The
effect re-issues it on every interim update, retargeting the in-flight animation
against a bottom that has already moved further down. At interim-transcript
rates the animation **never settles**, so the scroll position permanently trails
the bottom by far more than 10px.

Consequence: `!isNearBottom` is true for most scroll events during active
transcription, so the whole false-positive defence collapses onto guard (A).

### 3.2 Guard (A) is a zero-tolerance comparison of a cached value against live layout

Two independent defects in one line:

- **Zero tolerance.** `scrollTop` is a fractional `double`. A single frame
  reporting `812.66` after `812.91` — with no user near the device —
  disengages. Browser zoom and non-integral `devicePixelRatio` (routine on HiDPI
  laptops and kiosk panels) make fractional dither ordinary.
- **Cached vs live.** `lastScrollTopRef` was captured at a *previous* event,
  while `scrollHeight`/`clientHeight` are read *now*. Any interleaving where the
  offset moves down and the content grows before the handler runs is misread.
  See M6 below — this turns out to be the dominant mechanism.

### 3.3 Mechanisms that move `scrollTop` down with no user input

Ranked by how well each is established, after the review in §10 pushed back on
the first version of this table. The fix in §4 is engine-agnostic and does not
depend on picking the winner — but the ranking determines what G4 has to prove.

#### Tier 1 — established, engine-universal, sufficient on their own

**M6. Clamp-vs-growth race.** The strongest candidate, and it works on every
engine. A viewport resize reduces the maximum scroll offset, so the engine
clamps `scrollTop` down and queues a `scroll` event. Before the handler runs,
React commits new transcript text and `scrollHeight` grows by `G`. The handler
now reads a `scrollTop` that was clamped against the *old* content height
against a *new*, taller one:

```
isScrollingUp   = true                     (the clamp lowered scrollTop)
distanceToBottom ≈ G                       (the growth the clamp knew nothing about)
```

One line of new caption text is 40–96px on a kiosk display, so `G` clears the
10px threshold trivially. Both guards fail simultaneously. Triggers: window
resize, device rotation, iPad Split View / Stage Manager, `100dvh` churn, the
kiosk split-pane divider, the translated-captions panel mounting or unmounting,
and **any display-preference change** — `getBoundedDisplayPreferences` feeds
`displayHeightPx` and `verticalPositionPx` straight into the scroller's height
(`transcription-display-container.tsx:103-105`, `:154-155`). Requires a resize
to coincide with new text, which is exactly the "rare and random" signature.

**M7. Sub-pixel dither.** §3.2. Every engine, and more likely under zoom.

#### Tier 2 — plausible, engine-specific, not established

**M2. Stale scroll-position replica (WebKit / iOS).** iOS scrollers are
`UIScrollView`-backed; the offset is owned by the UI thread and the web process
holds a replica updated by delegate callbacks. A handler can therefore read a
*lagging* `scrollTop` against freshly computed `scrollHeight`/`clientHeight` —
structurally the same cached-vs-live failure as M6, but arising from the engine
rather than from the hook's own ref. *Correction from rev 1: "out-of-order
delivery" was overstated. Lagging reads are real; reordering is not a documented
behaviour.*

**M4. Rubber-band / overscroll settle (WebKit).** A post-flick bounce produces a
multi-frame decreasing sequence. Requires a prior user overscroll, so it cannot
explain a genuinely untouched kiosk — but it can explain a false disengage that
outlives a legitimate gesture.

**M5. Smooth-scroll retarget.** Re-issuing `scrollIntoView` several times a
second at a moving target. Chrome's easing does not overshoot; on iOS the
animation races the thread that owns the offset (M2). *Correction from rev 1:
Firefox's spring model (`general.smoothScroll.msdPhysics.enabled`) is **opt-in
and off by default**; the shipping curve is a non-overshooting cubic-bezier. The
rev-1 claim that Firefox overshoots by default was wrong.*

**M8. Assistive-technology scroll-to-reveal.** VoiceOver / NVDA moving through
the `role="log"` region scrolls it natively. Technically a user action, but not
a scrollback *intent* — today it silently stops the captions following.

#### Tier 3 — investigated and largely ruled out

**M1. Scroll anchoring (Chrome/Edge, Gecko; absent in WebKit).** Rev 1 called
this the prime suspect. It does not survive scrutiny. Anchor node selection
prefers the first partially-or-fully visible node in document order — i.e. near
the **top** of the scrollport — and anchoring only adjusts for content changes
**above** the anchor. In this app the mutating content (the interim `<span>` and
the growing active `<Typography>`) is the **bottom-most** node, below any
plausible anchor, and committed sections are immutable. Anchoring should be
inert here. The one residual path is a re-wrap of content *above* the anchor
(webfont swap at startup, container width change), which is rare and mostly
user-driven. `overflow-anchor: none` is retained in §5.2 as cheap insurance, not
as the fix.

**M3. Animated bounce-back on content shrink (iOS).** Rev 1 asserted UIKit
animates the offset back over many frames when content shrinks, producing
decreasing frames far from the bottom. **Withdrawn.** Work the arithmetic: from
a pinned position `scrollTop = H − C`, a shrink of `Δ` puts every intermediate
frame *beyond* the new bottom, so `distanceToBottom` is **negative** — the old
guard (B) reads that as near-bottom and the false positive cannot occur. From a
trailing position with lag `L`, either `Δ ≤ L` and nothing clamps at all, or
`Δ > L` and the clamp lands exactly on the new bottom. Neither path produces a
far-from-bottom decreasing frame. Content shrink matters only as an *input* to
M6, not as a mechanism of its own.

#### What still shrinks the content

Worth recording even though M3 is withdrawn, because it feeds M6: the reducer
`handleTranscript` in
`libs/store/transcription-content-store/src/transcription-content-slice.ts:243-262`
appends a finalized sequence and clears `inProgressTranscription` in the same
action. Recognisers routinely revise a long interim hypothesis into a shorter
final, so the rendered content shrinks by up to a line, several times a minute.

### 3.4 Why it never recovers

The re-engage branch needs a scroll event that is both *not scrolling up* and
*near the bottom*. Once disengaged nothing is scrolling, so no scroll events
fire, so the condition can never be met. The state is absorbing — which is why
a one-in-a-thousand misfire becomes a caption display that is dead for the rest
of the lecture.

### 3.5 Contributing factors

- `useEffect` (not `useLayoutEffect`) applies the scroll a frame *after* the new
  content paints — a visible lag, and the window M6 acts in.
- `scrollIntoView` scrolls **every** scrollable ancestor, not just the intended
  container — unwanted in the kiosk's nested split-pane layout.
- `lastScrollTopRef` starts at `0` and is never resynced after remount or
  `clearTranscription`.
- `libs/ui/live-translation-ui/src/components/translated-captions-panel.tsx:71`
  scrolls to bottom unconditionally with **no** scrollback detection at all, so
  a reader cannot scroll back through translated captions.

---

## 4. Fix strategy

**Stop inferring intent from scroll direction. Require positive evidence of a
user gesture before ever disengaging, and always self-heal at the bottom.**

1. **Intent gating.** A scroll event may only *disengage* auto-scroll if it is
   attributable to a real user gesture. Every mechanism in §3.3 arrives
   unattributed and is ignored — **engine-agnostic by construction**, which is
   why one fix covers Blink, WebKit and Gecko rather than three engine-specific
   patches, and why the Tier-2/Tier-3 uncertainty above does not put it at risk.

2. **Distance, not direction.** Recompute distance-from-bottom from live layout
   on every event. No cached `scrollTop`, so no cached-vs-live race (M6), no
   sub-pixel comparison (M7), no dependence on a fresh replica (M2).

3. **Hysteresis + self-healing.** Disengage above a generous threshold scaled to
   the caption line height; re-engage whenever the view is at the bottom
   *regardless of who put it there*. Even an unforeseen false disengage repairs
   itself the moment the view returns to the bottom, which kills §3.4.

4. **Remove the animation.** Pin with an explicit instant scroll in a layout
   effect. Kills M5, removes the permanent trailing lag (§3.1), removes
   `scrollIntoView`'s ancestor-scrolling side effect, and makes the scroll a
   synchronous clamp rather than something racing the iOS scrolling thread.

### 4.1 Gestures arm; scrolls open

This is the correction that rev 1 got wrong, and it is the most important
detail in the plan. Rev 1 let an input event *open* a session directly, and
blocked pinning while a session was open. That meant a tap on the caption region
— which is a documented affordance, since the region is `tabIndex={0}` so
keyboard and AT users can reach it — froze the captions for the settle window,
and repeated taps re-armed the timer and froze them **indefinitely**. That
reintroduces the exact bug being fixed, and makes it deliberately reproducible.

The corrected model has three states:

| State | Entered by | Effect |
|---|---|---|
| **idle** | default | scroll events cannot disengage |
| **armed** | a real input gesture (`pointerdown`, `touchstart`, `touchmove`, `wheel`, navigation-key `keydown`) | nothing yet — pinning continues normally |
| **active** | a scroll event arriving while armed, or continuing an active session | scroll events may disengage; pinning stands aside |

An input gesture that produces no scroll never leaves **armed**, so it never
blocks pinning. `armed` expires on a timer; `active` is extended by each further
scroll event (so iOS momentum stays attributed to the flick that caused it) and
closed by `scrollend` or a settle timeout.

### Non-goals

- **Do not** add `maximum-scale=1` / `user-scalable=no` to stabilise the iPad
  viewport. It breaks WCAG 1.4.4 (Resize Text) and this codebase demonstrably
  cares about a11y. The fix is immune to zoom anyway.
- **Do not** detect the engine and branch. Every branch is a place the bug can
  hide on a configuration nobody tested.

---

## 5. Target implementation

### 5.1 `libs/ui/transcription-display-ui/src/hooks/use-auto-scroll.ts` (rewrite)

```ts
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { createAutoScrollDiagnostics } from './auto-scroll-debug.js';

/**
 * Distance from the bottom (px) within which the view counts as pinned.
 * Small, but never zero: `scrollTop` is a fractional double, and browser zoom
 * or a non-integral devicePixelRatio put an exact match out of reach.
 */
const PIN_TOLERANCE_PX = 8;

/**
 * Floor for how far a user must scroll back before we stop following the
 * speaker. Scaled up with the caption line height by the caller, so one
 * accidental nudge on a large-type kiosk display does not disengage.
 * Deliberately far larger than PIN_TOLERANCE_PX - the gap between the two is
 * hysteresis, and without it the state flaps at the boundary.
 */
const MIN_SCROLLBACK_PX = 48;

/**
 * How long after an input gesture a scroll event is still that gesture's doing.
 * Covers the gap between `touchstart` and the drag actually moving. `touchmove`
 * re-arms, so a slow drag stays attributed however long the finger rests first.
 */
const USER_INPUT_ARM_MS = 400;

/**
 * Quiet period after the last scroll event before a user scroll session is
 * considered finished. It has to outlast iOS momentum, which keeps firing
 * scroll events for seconds after `touchend`, and it stands in for `scrollend`
 * on engines that do not implement it (Safari before 18.2).
 */
const SCROLL_SETTLE_MS = 300;

/**
 * Window after our own instant scroll in which a `scrollend` is assumed to be
 * ours. Without it, an engine that fires `scrollend` for programmatic scrolls
 * would close a user session mid-momentum and drop the rest of their flick.
 */
const PROGRAMMATIC_SCROLLEND_GRACE_MS = 50;

/**
 * Keys that scroll. A bare `keydown` filter would arm on Ctrl, Shift and every
 * character key, which is how a modifier press ends up looking like intent.
 */
const NAVIGATION_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar',
]);

/** Input events that arm the attribution window. */
const USER_INPUT_EVENTS = [
  'pointerdown', 'touchstart', 'touchmove', 'wheel', 'keydown',
] as const;

/**
 * Events that count as "someone is still here" while auto-scroll is disengaged.
 * Deliberately a *wider* set than USER_INPUT_EVENTS, and the asymmetry is the
 * point: arming needs narrow evidence, because a false positive stops the
 * captions. Idle detection needs broad evidence, because a false positive
 * yanks a present reader's place. Hover and focus are useless as intent but
 * excellent as presence, so they belong here and nowhere else.
 */
const IDLE_ACTIVITY_EVENTS = [
  'pointerdown', 'pointermove', 'touchstart', 'touchmove',
  'wheel', 'keydown', 'focusin',
] as const;

/**
 * Floor on how often a presence event may restart the idle timer. `pointermove`
 * fires up to ~120/s; a clearTimeout/setTimeout pair per event is cheap but
 * pointless at that rate.
 */
const IDLE_ACTIVITY_THROTTLE_MS = 5_000;

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
  // stays where they left it forever. See PLAN section 5.4 - this is a
  // deliberate per-app decision, not a default to inherit unthinkingly.
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
 * @param options Tuning knobs; see {@link UseAutoScrollOptions}.
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
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIdleResetAtRef = useRef(Number.NEGATIVE_INFINITY);
  const diagnosticsRef = useRef(createAutoScrollDiagnostics(label));

  const scrollbackThresholdPx = Math.max(MIN_SCROLLBACK_PX, lineHeightPx * 1.5);

  const scrollToBottom = useCallback(() => {
    const container = textContainerRef.current;
    if (!container) return;
    lastProgrammaticScrollAtRef.current = performance.now();
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

  const closeUserScrollSession = useCallback(() => {
    userScrollActiveRef.current = false;
    armedAtRef.current = Number.NEGATIVE_INFINITY;
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const extendUserScrollSession = useCallback(() => {
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(closeUserScrollSession, SCROLL_SETTLE_MS);
  }, [closeUserScrollSession]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    lastIdleResetAtRef.current = Number.NEGATIVE_INFINITY;
  }, []);

  /**
   * Arm (or re-arm) the idle re-engage timer. Only meaningful while
   * disengaged; the disengage path starts it and every subsequent scroll or
   * presence event pushes it back out.
   */
  const restartIdleTimer = useCallback(() => {
    if (idleReengageMs === null) return;
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      // Never yank someone whose finger is still on the glass.
      if (userScrollActiveRef.current) {
        restartIdleTimer();
        return;
      }
      diagnosticsRef.current.recordIdleReengage();
      closeUserScrollSession();
      setIsAutoScrollEnabled(true);
      // The pin itself is left to the layout effect: `isAutoScrollEnabled`
      // just changed, so it is about to run anyway, and routing through it
      // keeps one code path responsible for touching the scroll offset.
    }, idleReengageMs);
  }, [idleReengageMs, closeUserScrollSession]);

  const handleScroll = useCallback(() => {
    const container = textContainerRef.current;
    if (!container) return;

    // A scroll event is the user's if it continues an open session (iOS
    // momentum) or lands inside the window an input gesture armed. Note this
    // is the *only* place a session opens - see the note in the hook doc.
    if (
      userScrollActiveRef.current ||
      performance.now() - armedAtRef.current < USER_INPUT_ARM_MS
    ) {
      userScrollActiveRef.current = true;
      extendUserScrollSession();
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    if (distanceFromBottom <= PIN_TOLERANCE_PX) {
      // At the bottom - follow the speaker again, whoever scrolled us here.
      // Deliberately ungated: this is the self-healing path, and it is what
      // stops a false disengage from being permanent. React bails out when the
      // value is unchanged (`Object.is`), so the common case costs no render.
      clearIdleTimer();
      setIsAutoScrollEnabled(true);
      return;
    }

    // Any scroll away from the bottom means someone is still reading, so push
    // the idle deadline back out. Harmless when the timer is not running.
    restartIdleTimer();

    // Below this line we would disengage, and only a real gesture may do that.
    if (!userScrollActiveRef.current) {
      diagnosticsRef.current.recordSuppressed(distanceFromBottom);
      return;
    }

    if (distanceFromBottom > scrollbackThresholdPx) {
      diagnosticsRef.current.recordUserDisengage(distanceFromBottom);
      setIsAutoScrollEnabled(false);
      restartIdleTimer();
    }
  }, [
    extendUserScrollSession,
    scrollbackThresholdPx,
    clearIdleTimer,
    restartIdleTimer,
  ]);

  /**
   * Re-engage and pin. The jump-to-bottom control must call this rather than
   * setting the flag, because the pin effect declines to run while a user
   * scroll session is open - a tap on the button inside the settle window
   * would otherwise flip the flag and scroll nothing.
   */
  const jumpToBottom = useCallback(() => {
    closeUserScrollSession();
    clearIdleTimer();
    setIsAutoScrollEnabled(true);
    scrollToBottom();
  }, [closeUserScrollSession, clearIdleTimer, scrollToBottom]);

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

    // Presence, not intent (see IDLE_ACTIVITY_EVENTS). Throttled because
    // `pointermove` fires far faster than a 3-minute deadline needs.
    const noteReaderPresent = () => {
      if (idleTimerRef.current === null) return;
      const now = performance.now();
      if (now - lastIdleResetAtRef.current < IDLE_ACTIVITY_THROTTLE_MS) return;
      lastIdleResetAtRef.current = now;
      restartIdleTimer();
    };

    const options = { capture: true, passive: true } as const;
    for (const type of USER_INPUT_EVENTS) {
      container.addEventListener(type, armUserIntent, options);
    }
    for (const type of IDLE_ACTIVITY_EVENTS) {
      container.addEventListener(type, noteReaderPresent, options);
    }
    // Closes the session promptly where supported (Chrome 114+, Firefox 109+,
    // Safari 18.2+). The settle timer is the fallback everywhere else, so no
    // feature detection is needed - whichever fires first wins.
    container.addEventListener('scrollend', handleScrollEnd);

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
    };
  }, [closeUserScrollSession, clearIdleTimer, restartIdleTimer]);

  // Layout effect, not effect: pin in the same frame the new text lays out,
  // before paint. Under `useEffect` the browser gets a frame in which the
  // content has grown but the scroll has not moved.
  useLayoutEffect(() => {
    if (!isAutoScrollEnabled) return;
    // Never fight a scroll actually in flight. Note this tests the *active*
    // session, not merely armed intent - a tap must not stop the captions.
    if (userScrollActiveRef.current) return;
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [...dependencies, isAutoScrollEnabled, scrollToBottom]);

  return { isAutoScrollEnabled, textContainerRef, handleScroll, jumpToBottom };
};
```

**API changes:** `textBottomRef` is gone (nothing scrolls to a sentinel any
more) and `setIsAutoScrollEnabled` is replaced by `jumpToBottom`, so callers
cannot reintroduce the flag-without-pin bug. `libs/ui/transcription-display-ui`
is an internal workspace package with one consumer; `tsc --build` catches both.

### 5.2 `transcription-display-container.tsx`

```diff
   const {
     isAutoScrollEnabled,
-    setIsAutoScrollEnabled,
     textContainerRef,
-    textBottomRef,
     handleScroll,
-  } = useAutoScroll([
-    commitedSections,
-    activeSection,
-    inProgressTranscriptionText,
-    containerHeightPx,
-    displayHeightPx,
-  ]);
+    jumpToBottom,
+  } = useAutoScroll(
+    [
+      commitedSections,
+      activeSection,
+      inProgressTranscriptionText,
+      containerHeightPx,
+      displayHeightPx,
+    ],
+    { lineHeightPx, label: 'transcription' },
+  );
```

```diff
             sx={{
               marginTop: `${verticalPositionPx.toString()}px`,
               height: `${displayHeightPx.toString()}px`,
               width: '100%',
               overflowY: 'scroll',
+              // Belt-and-braces, not the fix (see PLAN section 3.3, M1):
+              // Blink and Gecko reposition the scroll offset to hold an
+              // "anchor" node still when content above it changes size. The
+              // anchor should sit above everything that mutates here, but a
+              // re-wrap from a late webfont or a width change can still reach
+              // above it, and an append-only caption log gains nothing from
+              // anchoring in any case. No-op in WebKit, which does not
+              // implement it.
+              overflowAnchor: 'none',
+              // Keep overscroll inside this box: no chaining to the page, and
+              // a damped rubber-band on iOS.
+              overscrollBehavior: 'contain',
               '&::-webkit-scrollbar': {
```

```diff
-          <Box ref={textBottomRef} />
           </Box>
           <JumpToBottomButton
             visible={!isAutoScrollEnabled}
-            onClick={() => {
-              setIsAutoScrollEnabled(true);
-            }}
+            onClick={jumpToBottom}
           />
```

No `scroll-behavior: auto` rule: `scrollTo({ behavior: 'instant' })` overrides
CSS explicitly, so the rule the first revision proposed would have been
defending against nothing. Verified there is no global `scroll-behavior: smooth`
in the repo today.

### 5.3 `translated-captions-panel.tsx`

Replace the unconditional `bottomRef.current?.scrollIntoView(...)` at line 71
with the same hook, so translated captions gain the scrollback support they
currently lack plus the same protections:

```ts
const { isAutoScrollEnabled, textContainerRef, handleScroll, jumpToBottom } =
  useAutoScroll([segments], { lineHeightPx, label: 'translation' });
```

`live-translation-ui` must take a workspace dependency on
`@scribear/transcription-display-ui`, or the hook lifts to `core-ui` — pick one
and record it. Add the same two CSS rules, and a `JumpToBottomButton` (the panel
has none today, so scrollback would otherwise be a trap).

### 5.4 Idle re-engage after scrollback

**Requirement:** once the reader has scrolled back, return to following the
speaker after 3 minutes with no scrolling.

This is the last piece that makes a disengage non-absorbing. §3.4 identified the
absorbing state as the reason a one-in-a-thousand misfire kills a display for a
whole lecture; the self-heal path in `handleScroll` only fires if *something*
scrolls back to the bottom. On an unattended kiosk nothing ever will. The idle
timer closes that hole for the case the self-heal cannot reach.

**What resets the 3 minutes.** Any scroll event away from the bottom, plus any
event in `IDLE_ACTIVITY_EVENTS`. That set is deliberately **wider** than the set
that arms a disengage, and the asymmetry carries the whole design:

|  | Arming a disengage | Resetting the idle timer |
|---|---|---|
| Question asked | "did the user mean to scroll?" | "is anyone still there?" |
| Cost of a false positive | captions stop following — the bug | a walked-away kiosk waits longer |
| Cost of a false negative | a real scrollback is ignored (view keeps following) | a present reader loses their place |
| Evidence required | **narrow**: `pointerdown`, `touchstart`, `touchmove`, `wheel`, navigation `keydown` | **broad**: the above plus `pointermove` and `focusin` |

Hover is useless as intent — a mouse resting over the captions means nothing —
but excellent as presence. Putting `pointermove` in one set and not the other is
the difference between a laptop reader never being interrupted and being yanked
every three minutes.

**What it does on fire.** Guards on `userScrollActiveRef` (never yank a finger
that is still on the glass; re-arm instead), closes the session, sets the flag,
and lets the existing layout effect do the pin, so exactly one code path ever
touches the scroll offset.

**Known casualty: touch devices have no hover.** On an iPad, a reader who
scrolls back and reads history for three minutes without touching the screen
produces *no* presence events and will be returned to the bottom. There is no
signal available that distinguishes them from a room whose presenter walked
away. This is a real cost, and it is why the option defaults to `null`.

**Per-app configuration** — `idleReengageMs`, defaulting to `null` (disabled):

| App | Recommended | Why |
|---|---|---|
| `kiosk-webapp` | **`180_000`** | Unattended room display. "Captions dead for the rest of the lecture" is a far worse outcome than "someone reading history loses their place once". |
| `client-webapp` | `180_000` | Personal device, but 3 minutes of *zero* input is a strong walked-away signal, and on a laptop `pointermove` keeps a present reader safe. |
| `standalone-webapp` | `180_000` | As above. |

All three are the same recommendation, but they are three separate decisions in
three call sites rather than one shared default, because the trade-off differs
by deployment and a future app should have to think about it. Anyone who wants
the old "stay where I put it forever" behaviour passes `null`.

**Accessibility.** This is an automatic, timed change of the reader's position,
so it engages WCAG 2.2.2 (Pause, Stop, Hide): the ability to scroll back *is*
the pause mechanism for auto-updating content, and a timer that revokes it after
3 minutes weakens that. Two things keep this defensible, and both must hold:

- The reader can always scroll back again, immediately and indefinitely — the
  mechanism is delayed, not removed.
- Any presence signal resets it, so a reader who is actually interacting is
  never interrupted.

Live captions of a real-time event also fall under the SC 2.2.1 real-time
exception. Even so, **G7b must confirm this specifically with a screen reader**
rather than assume it: an idle re-engage while VoiceOver's cursor is parked in
the transcript is a bad experience, and `focusin` alone may not be enough to
detect an AT user reading without moving focus. If row 12 finds this, the
correct answer is to disable the timer while the region contains focus, not to
shorten it.

**Not building a countdown.** A visible timer would be more transparent but adds
a moving element to a caption display whose whole job is legibility. The
jump-to-bottom button already communicates the disengaged state.

### 5.5 Field diagnostics — `src/hooks/auto-scroll-debug.ts` (new)

An iPad in a lecture hall cannot be reproduced against on a laptop. Ship a
counter so the soak (§6.5) and anyone with remote Web Inspector can *measure*
the fix rather than assume it.

```ts
/**
 * Per-instance auto-scroll diagnostics, keyed by label. Two caption regions are
 * mounted at once on the kiosk (transcription + translated captions); a single
 * global object would let whichever mounted last silently erase the other's
 * numbers.
 */
export interface AutoScrollDiagnostics {
  // Times auto-scroll was switched off by an attributed user gesture.
  // Expected 0 on an untouched kiosk.
  userDisengagements: number;
  // Scroll events that would have disengaged under the old direction-based
  // rule but were correctly ignored as unattributed. This is the bug, counted:
  // non-zero here is healthy, and quantifies how often the old code misfired.
  suppressedDisengagements: number;
  // Distance from the bottom at the last suppressed event, for triage.
  lastSuppressedDistancePx: number;
  // Times the idle timer returned the view to the bottom (section 5.4). On a
  // kiosk this is the count of "someone scrolled back and walked away", and
  // a suspiciously high number means the disengage threshold is too eager.
  idleReengagements: number;
}

/**
 * Returns a recorder for one hook instance. Counting is a couple of integer
 * increments per scroll event, so it always runs; only publication to `window`
 * is gated, and the registry is namespaced by label.
 */
export function createAutoScrollDiagnostics(label: string): {
  recordSuppressed(distancePx: number): void;
  recordUserDisengage(distancePx: number): void;
  recordIdleReengage(): void;
  snapshot(): AutoScrollDiagnostics;
};
```

Publish as `window.__scribearAutoScroll[label]` behind
`import.meta.env.DEV || localStorage.getItem('scribear:debugAutoScroll')`, so
production kiosks pay nothing unless asked. Deregister the label on unmount.

### 5.6 iPad kiosk viewport hygiene — **separate PR**

Split out of this change on review (§10, M4). It is not the root cause; it is
what makes M6 fire more often on iPad, and it changes viewport semantics in ways
this plan's tests do not cover. Track it as its own PR with its own G4 row.

- `apps/kiosk-webapp/public/favicon/site.webmanifest` still reads
  `"name": "MyWebSite"`, `"short_name": "MySite"` — generator boilerplate.
  Set these to ScribeAR; set `theme_color`/`background_color` to the kiosk's
  caption theme rather than `#ffffff`.
- `index.html` has `apple-mobile-web-app-title` but not
  `apple-mobile-web-app-capable`. iPadOS 16.4+ honours the manifest's
  `display: standalone`; older iPadOS needs the legacy meta. A chrome-free
  standalone window is a viewport that does not resize underneath the captions.
- `viewport-fit=cover` + `env(safe-area-inset-*)` padding so captions clear the
  home indicator. **Do not** touch `user-scalable` / `maximum-scale` (§4).

---

## 6. Test plan

`vitest` + jsdom, project `unit`, per
`libs/ui/transcription-display-ui/vitest.config.ts`.

**jsdom has no layout engine**: `scrollHeight` and `clientHeight` are always `0`
and `scrollTop` neither clamps nor emits events. Every test below therefore
needs a fake scroller. Build it once.

### 6.1 Harness — `tests/fake-scroller.ts` (new)

```ts
/**
 * jsdom implements no layout, so a real element reports scrollHeight 0 and
 * never emits a scroll event. This installs a minimal scroller model on an
 * element: settable content/viewport heights, a clamping scroll offset,
 * `scroll` events, and a working `scrollTo` - enough to drive every mechanism
 * in the plan's section 3.3.
 */
export interface FakeScroller {
  el: HTMLElement;
  setContentHeight(px: number): void;   // grow/shrink; clamps + emits if the offset moved
  setViewportHeight(px: number): void;  // resize; clamps + emits if the offset moved
  scrollTo(px: number): void;           // engine-driven move; clamps + emits
  /** Emit a scroll reporting `px` verbatim, bypassing the clamp. Models a stale
   *  replica read (M2) and any frame the engine reports out of range. */
  emitRawScroll(px: number): void;
  /** Apply a content-height change and a scroll event in the wrong order, so a
   *  handler sees an offset clamped against the old height and the new one.
   *  This is M6, the primary mechanism, and it needs explicit support. */
  clampThenGrow(shrinkViewportBy: number, growContentBy: number): void;
  get scrollTop(): number;
  get maxScrollTop(): number;
}

export function installFakeScroller(
  el: HTMLElement,
  init: { contentHeight: number; viewportHeight: number; scrollTop?: number },
): FakeScroller;
```

Back it with a mutable record plus `Object.defineProperty` for `scrollHeight`,
`clientHeight` and `scrollTop`, and a real `scrollTo` honouring
`behavior: 'instant'`. The `scrollTop` setter clamps to
`max(0, contentHeight − viewportHeight)` and dispatches `new Event('scroll')`
when the value changes — which is what lets tests assert the *production*
`scrollToBottom` really pins.

Add to `tests/setup.ts`: jsdom implements neither `scrollend` nor
`Element.prototype.scrollTo`. Stub `scrollTo` and note explicitly that
`scrollend` is deliberately absent, so the settle-timer fallback is what gets
exercised by default and nobody "fixes" it later.

### 6.2 Regression tests — `tests/hooks/use-auto-scroll.test.tsx` (new)

Each **must fail against the current implementation** and pass after. Gate G0.

| # | Test | Simulates | Setup | Expect |
|---|---|---|---|---|
| 1 | clamped offset measured against grown content does not disengage | **M6, primary** | `clampThenGrow(200, 300)`, no input event | engaged |
| 2 | …at every growth size from 1 line to 10 | M6 | parameterised over `G ∈ {40, 96, 400}` | engaged |
| 3 | sub-pixel dither does not disengage | M7 | `emitRawScroll(812.91) → (812.66)` | engaged |
| 4 | a lagging offset read does not disengage | M2 | `emitRawScroll(bottom − 300)` with content unchanged, no input | engaged |
| 5 | a bounce/settle ramp does not disengage | M4 | 6-frame decreasing ramp, no input | engaged |
| 6 | a content shrink below the offset does not disengage | shrink → M6 input | `setContentHeight(−120)` while pinned | engaged |
| 7 | user wheels back past the threshold | genuine | `wheel`, then `scrollTo(bottom − 400)` | **disengaged** |
| 8 | user drags back on touch | genuine, iPad | `touchstart`, then `scrollTo(bottom − 400)` | disengaged |
| 9 | keyboard PageUp | genuine, a11y | focus, `keydown{PageUp}`, `scrollTo(bottom − 400)` | disengaged |
| 10 | **tap with no scroll never blocks pinning** | **regression from rev 1 (§10 H1)** | `pointerdown` (+`touchstart`), no scroll, then 5 content updates over 2s | pinned on **every** update; never freezes |
| 11 | **repeated taps never freeze the display** | rev-1 regression | 10 × `pointerdown` at 100ms intervals with content updates throughout | pinned throughout |
| 12 | **modifier and character keys do not arm** | rev-1 regression | `keydown{Control}`, `keydown{a}`, then an unattributed scroll to `bottom − 400` | engaged |
| 13 | navigation keys do arm | complement of 12 | `keydown{ArrowUp}` then scroll | disengaged |
| 14 | arm window expires | attribution | `wheel`, advance `USER_INPUT_ARM_MS + 1`, then scroll to `bottom − 400` | engaged |
| 15 | arm window boundary | attribution | assert at `ARM_MS − 1` (attributed) and `ARM_MS + 1` (not) | both |
| 16 | slow drag stays attributed | touch | `touchstart`, 2s of `touchmove` with no scroll, then scroll | disengaged |
| 17 | momentum outlasting the settle window | iPad | `touchstart`, `touchend`, scroll events at t+400/900/1600/2400/3000ms | disengaged for the whole ramp |
| 18 | settle-window boundary | timers | last scroll, then assert session open at `SETTLE_MS − 1`, closed at `SETTLE_MS + 1` | both |
| 19 | nudge below threshold does not disengage | hysteresis | `wheel`, `scrollTo(bottom − 20)`, `lineHeightPx: 40` | engaged |
| 20 | threshold scales with line height | hysteresis | `lineHeightPx: 96` → 144px; `wheel` + `scrollTo(bottom − 100)` | engaged |
| 21 | threshold boundary | `>` vs `>=` | exactly `scrollbackThresholdPx`, then `+1` | engaged, then disengaged |
| 22 | `lineHeightPx` change mid-session | prefs | disengage at 40px, re-render with 96px, further scrolls | no spurious re-engage; threshold recomputed |
| 23 | user returns to the bottom | self-heal | disengage, then `wheel` + `scrollTo(max)` | engaged |
| 24 | unattributed arrival at the bottom re-engages | self-heal | disengage, then `emitRawScroll(max)` | engaged — deliberately ungated |
| 25 | re-engage mid-gesture is not suppressed | self-heal vs user | open a session, pass through the pin zone, keep scrolling past the threshold | ends disengaged; documents the transient |
| 26 | resize while **disengaged** | M6 + self-heal | `setViewportHeight` clamping to the new bottom | re-engages; asserted as intended, not accidental |
| 27 | pins instantly, never with an animation | §3.1 | spy `scrollIntoView` and `scrollTo`; push an update | `scrollIntoView` **not called**; `scrollTo` called with `behavior: 'instant'` |
| 28 | does not scroll while a **scroll** is in flight | user-first | open a session by scrolling, then a content update | offset unchanged |
| 29 | re-pins after a viewport resize while engaged | M6 | `setViewportHeight` + content update | back at the bottom |
| 30 | `clearTranscription` while engaged | reset | content → 0 | no crash; pinned; engaged |
| 31 | `clearTranscription` while disengaged | reset | content → 0 | re-engages once the bottom is reachable |
| 32 | `jumpToBottom` during the settle window | **§10 T14** | open a session, call `jumpToBottom` before `SETTLE_MS` | engaged **and** offset at max |
| 33 | programmatic `scrollend` does not close a user session | **§10 T13** | open a session, pin, dispatch synthetic `scrollend` within the grace window | session still open; a later scroll still disengages |
| 34 | real `scrollend` closes the session | complement of 33 | dispatch `scrollend` outside the grace window | session closed |
| 35 | StrictMode double-mount | **§10 T4** | render under `<StrictMode>` | listeners attached once net; no orphaned timer; no double-pin; no act() warning |
| 36 | unmount removes all listeners | leak | unmount, then `emitRawScroll` | no state update, no act() warning |
| 37 | gesture originating outside the container | **§10 T3** | dispatch `wheel` on a sibling, then scroll the container | engaged — accepted limitation, asserted so it is a decision |
| 38 | two instances do not interfere | **§10 M5** | mount transcription + translation panels; scroll one | only that one disengages; both diagnostics labels present |
| 39 | idle re-engage fires after the configured delay | **§5.4** | `idleReengageMs: 180_000`; disengage; advance 180s with no events | engaged **and** pinned to the bottom |
| 40 | idle re-engage boundary | §5.4 | assert still disengaged at `179_999ms`, engaged at `180_001ms` | both |
| 41 | a scroll while disengaged resets the deadline | §5.4 | disengage; at t+170s scroll (still away from the bottom); advance to t+180s | still disengaged; fires at t+350s |
| 42 | `pointermove` alone resets the deadline | §5.4 presence | disengage; `pointermove` every 30s for 5 min | **never** re-engages — a laptop reader is not interrupted |
| 43 | `focusin` resets the deadline | §5.4, a11y | disengage; `focusin` at t+170s | deadline pushed out |
| 44 | presence resets are throttled | perf | 500 × `pointermove` in one tick | at most one `restartIdleTimer` per `IDLE_ACTIVITY_THROTTLE_MS` |
| 45 | never fires mid-gesture | §5.4 guard | disengage; open a user scroll session; let the deadline elapse | re-arms instead of firing; fires only after the session closes |
| 46 | `idleReengageMs: null` disables it entirely | §5.4 default | disengage; advance 30 min with no events | still disengaged; no timer left pending |
| 47 | `jumpToBottom` cancels a pending idle timer | §5.4 | disengage; `jumpToBottom`; advance 5 min | one re-engage, not two; no orphaned timer |
| 48 | reaching the bottom cancels a pending idle timer | §5.4 | disengage; scroll back to the bottom; advance 5 min | no second re-engage |
| 49 | idle timer is cleared on unmount | leak | disengage; unmount; advance 5 min | no state update, no act() warning |

Use `vi.useFakeTimers()` and assert the `USER_INPUT_ARM_MS` /
`SCROLL_SETTLE_MS` / `PROGRAMMATIC_SCROLLEND_GRACE_MS` boundaries explicitly
(tests 15, 18, 21, 33) so the timers are covered rather than incidentally
exercised. `performance.now()` must be included in the faked clock
(`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })`).

### 6.3 Component tests — extend `tests/components/transcription-display-container.test.tsx`

- The scroll container carries `overflow-anchor: none` and
  `overscroll-behavior: contain`.
- The jump-to-bottom button is hidden while engaged, shown once disengaged.
- Clicking it re-engages **and** pins — including during the settle window
  (the §6.2 #32 path, asserted here at the component level too).
- `axeViolations(container)` still returns `[]`; the region keeps `role="log"`,
  `tabindex="0"` and its accessible name (existing tests must not regress).
- A tap on the caption region (its documented focus affordance) does not stop
  captions updating — the user-visible form of #10.

### 6.4 New tests — `libs/ui/live-translation-ui`

Mirror §6.2 #1, #3, #7, #10, #23 for `TranslatedCaptionsPanel` once it adopts
the hook, plus: a reader can scroll back through translated captions and stay
there while new segments arrive (a **new capability**, not a regression fix),
and the new jump-to-bottom control returns them.

### 6.5 E2E soak — `tools/e2e-audio/kiosk-audio-e2e.mjs`

The existing puppeteer harness drives a real Chromium kiosk with audio streaming
from a WAV fixture into a live provider — the only place in the repo that
reproduces the real timing. Extend it:

- Set `localStorage['scribear:debugAutoScroll'] = '1'` before `page.goto`.
- Add a soak invocation with `--stream-seconds 600`.
- Assert `window.__scribearAutoScroll.transcription.userDisengagements === 0`
  (nothing touched the page) and that the jump button was never visible.
- **Resize during the soak.** M6 is the primary mechanism and needs a resize to
  fire, so a static-viewport soak does not exercise it. Drive
  `page.setViewport()` every ~20s mid-stream, and toggle the translated-captions
  panel, so resizes coincide with arriving text.
- Report `suppressedDisengagements` and `idleReengagements` in `--json`. The
  first *is* the bug: on current code those events are the failures.
- **Assert the idle recovery end-to-end.** Mid-soak, scroll the caption region
  back with a real `page.mouse.wheel`, confirm it disengages, then leave the
  page untouched (no synthetic mouse movement — puppeteer emits `pointermove`
  that would reset the deadline) and confirm it returns to the bottom within
  `180_000ms + slack`. Run this against a build with a shortened
  `idleReengageMs` so the soak does not have to burn three real minutes.

Also run the page through `page.emulate()` with an iPad descriptor.
**This does not substitute for real-device testing** — puppeteer emulation is
still Blink, so M2 and M4 are not exercised at all. State this in the PR; do not
let a green emulated run stand in for G4.

---

## 7. Gates

| Gate | Check | Command / procedure |
|---|---|---|
| **G0** | Every §6.2 regression test fails against `main` before the fix | run the new test file with the hook rewrite reverted; record the failure list in the PR |
| **G0b** | Tests 10, 11, 12, 32 fail against **revision 1** of this plan's hook | proves the §10 H1/T14 corrections are actually tested, not just described |
| **G1** | Unit tests green; `use-auto-scroll.ts` ≥ 95% lines **and** branches | `npm run test:unit -w @scribear/transcription-display-ui` and `-w @scribear/live-translation-ui` |
| **G2** | Full workspace unit suite green | `npm run test:unit` |
| **G3** | Lint, format, typecheck, build | `npm run lint && npm run format && npm run build` |
| **G4** | Real-device matrix — no spurious disengage in a 10-minute streaming soak per row | manual, table below |
| **G5** | Instrumented soak with mid-stream resizes: `userDisengagements === 0` over ≥ 10 min untouched | `npm run e2e:audio -- --provision --stream-seconds 600 --json` |
| **G6** | Existing e2e unaffected | `npm run e2e:audio`, `npm run e2e:translation` |
| **G7** | a11y unchanged | `npm run a11y:axe`; the `role="log"` region keeps its name, role and `tabindex` |
| **G7b** | Idle re-engage (§5.4) does not disrupt a screen-reader user parked in the transcript | VoiceOver (macOS + iPad) and NVDA: scroll back, leave the AT cursor in the region, wait 3½ min. If it fires and is disruptive, disable the timer while the region contains focus — do **not** merely lengthen it |
| **G8** | Changeset added (repo uses `@changesets/cli`; both UI packages are versioned) | `npm run changeset` |

### G4 device matrix

Each row: start a session, stream ≥ 10 minutes of speech, **do not touch the
device**, confirm captions still follow and the jump button never appears. Then
(a) scroll back by hand and confirm it disengages, (b) return to the bottom and
confirm it re-engages, (c) **tap the caption region once and confirm captions
keep updating** — the §10 H1 regression, which is device-visible.

| # | Device / OS | Browser | Mechanisms |
|---|---|---|---|
| 1 | Laptop, macOS | Chrome | M6, M7, M1 |
| 2 | Laptop, macOS | Safari | M2, M5, M6 |
| 3 | Laptop, macOS | Firefox | M6, M7, M1 |
| 4 | Laptop, Windows | Edge + Chrome | M6, M7 |
| 5 | Laptop, Linux | Chrome/Chromium (kiosk reference) | M6, M7 |
| 6 | **iPad, Safari tab** | WebKit | M2, M4, M6, M8 |
| 7 | **iPad, home-screen standalone** | WebKit | M2, M4, M6 — the actual deployment |
| 8 | **iPad, rotate + Split View mid-stream** | WebKit | M6 — the primary mechanism, deliberately provoked |
| 9 | iPhone, Safari | WebKit | M2, M4, M6 (`100dvh` toolbar churn) |
| 10 | Android phone, Chrome | Blink | M6, M7, M1 |
| 11 | Any, browser zoom 150% / 175% | any | M7 |
| 12 | macOS VoiceOver + iPad VoiceOver | Safari | M8 — AT navigation must not disengage or freeze |
| 13 | Any, drag the kiosk split-pane divider during speech | any | M6 |
| 14 | Any, change font size / line count in the prefs drawer during speech | any | M6 via `displayHeightPx` |
| 15 | **Any, scroll back and walk away for 3½ minutes** | any | §5.4 — must return to the bottom on its own |
| 16 | **Laptop, scroll back and keep the mouse over the captions for 5 minutes** | Chrome/Safari/Firefox | §5.4 presence — must **not** re-engage |
| 17 | **iPad, scroll back and read without touching for 3½ minutes** | WebKit | §5.4 known casualty — confirm the yank is tolerable in the room, or reconsider `idleReengageMs` for touch |

Rows 6–8 are why this plan exists; **do not sign off G4 without a physical
iPad.** Attach Safari Web Inspector from a Mac (iPad: Settings → Apps → Safari →
Advanced → Web Inspector) and read `window.__scribearAutoScroll` after each soak.

Rows 8, 13 and 14 target M6 directly and are the highest-value manual rows —
they are the ones most likely to reproduce the original bug on *current* code,
which is worth confirming before the fix lands.

**Not a gate:** the rev-1 plan proposed toggling iPadOS Reduce Motion as a cheap
discriminator between mechanisms, on the premise that WebKit maps
`scrollIntoView({behavior:'smooth'})` to instant under that setting. That is
documented for CSS `scroll-behavior` but not reliably for the scriptic form, so
a negative result would prove nothing. Use the diagnostics counter instead.

---

## 8. Todo

### A. Core fix
- [ ] A1. Add `tests/fake-scroller.ts` (§6.1), including `clampThenGrow` for M6.
- [ ] A2. Add `tests/hooks/use-auto-scroll.test.tsx` with the §6.2 table, written against the **current** hook. Record which fail (**G0**).
- [ ] A3. Rewrite `use-auto-scroll.ts` per §5.1: arm-then-open intent gating, navigation-key filter, distance-based decision, hysteresis, instant pin, `useLayoutEffect` for both effects, `scrollend` grace window.
- [ ] A4. Delete `lastScrollTopRef` and the `textBottomRef` sentinel; replace `setIsAutoScrollEnabled` with `jumpToBottom` in `UseAutoScrollResult`.
- [ ] A5. Update `transcription-display-container.tsx` per §5.2 — pass `lineHeightPx`/`label`, add the two CSS rules, drop the sentinel, wire the button to `jumpToBottom`.
- [ ] A6. Add the idle re-engage timer per §5.4: `idleReengageMs` option, `restartIdleTimer`/`clearIdleTimer`, the `IDLE_ACTIVITY_EVENTS` presence listeners with throttling, and the mid-gesture guard.
- [ ] A7. Pass `idleReengageMs: 180_000` from all three app call sites (`kiosk-webapp`, `client-webapp`, `standalone-webapp` `root.tsx`) — three explicit decisions, not a shared default.
- [ ] A8. Confirm every A2 test passes, including 10/11/12/32 and 39–49 (**G1**, **G0b**).

### B. Translated captions
- [ ] B1. Decide where the shared hook lives (export from `transcription-display-ui`, or lift to `core-ui`); record the choice.
- [ ] B2. Adopt the hook in `translated-captions-panel.tsx`, replacing the unconditional `scrollIntoView` at line 71.
- [ ] B3. Add the two CSS rules and a `JumpToBottomButton` to that panel.
- [ ] B4. Add §6.4 tests, including the new scroll-back-through-translations capability.

### C. Diagnostics
- [ ] C1. Add `auto-scroll-debug.ts` (§5.5) with a label-keyed registry, and wire both counters into `handleScroll`.
- [ ] C2. Publish `window.__scribearAutoScroll[label]` behind the DEV/localStorage guard; deregister on unmount.
- [ ] C3. Extend `tools/e2e-audio/kiosk-audio-e2e.mjs` per §6.5, **including mid-stream viewport resizes**; surface the counters in `--json`.

### D. Verification & release
- [ ] D1. **G2/G3** — full workspace unit suite, lint, format, build.
- [ ] D2. **G5/G6** — instrumented 10-minute soak with resizes, plus existing e2e suites.
- [ ] D3. **G7** — `npm run a11y:axe`; VoiceOver/NVDA pass on row 12.
- [ ] D4. **G4** — real-device matrix; iPad rows 6–8 mandatory; rows 8/13/14 also run against *current* code to confirm the M6 attribution.
- [ ] D5. **G8** — changeset for `@scribear/transcription-display-ui` and `@scribear/live-translation-ui`.
- [ ] D6. PR write-up: the §3.3 tiering (including what was withdrawn), the G0/G0b failure lists, the G4 sign-off grid, and an explicit note that puppeteer iPad emulation is Blink and did **not** cover M2/M4.

### E. Separate PR — iPad kiosk viewport hygiene (§5.6)
- [ ] E1. Replace the placeholder `site.webmanifest` name/short_name/colours.
- [ ] E2. Add `apple-mobile-web-app-capable` to `apps/kiosk-webapp/index.html`.
- [ ] E3. Add `viewport-fit=cover` + `env(safe-area-inset-*)` padding. **Do not** touch `user-scalable`/`maximum-scale`.
- [ ] E4. Apply E1–E3 to `client-webapp` and `standalone-webapp` where the same boilerplate exists.
- [ ] E5. Re-run G4 rows 6–8 after the viewport-mode change.

### F. Follow-ups (not blocking)
- [ ] F1. `handleScroll` forces layout via `scrollHeight` on every scroll event. Bounded and small, but check against `cpu-findings.md` targets on the lowest-spec kiosk.
- [ ] F2. Consider a "captions paused" affordance — today the only signal that following stopped is the jump button appearing.
- [ ] F3. If G4 row 17 shows the idle yank is disruptive on touch, add a presence signal that works without hover — e.g. treat `visibilitychange` to visible, or an `IntersectionObserver`-backed "is anyone looking" proxy — rather than lengthening the delay.
- [ ] F4. Consider surfacing `idleReengagements` on the kiosk status panel. A high count means the disengage threshold is too eager and people are being dropped out of follow mode by accident.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| A user gesture producing **no** input event on the container fails to disengage (e.g. a drag chaining in from outside, or an exotic assistive device) | The scrollbar is `display: none`, so scrollbar-drag is unreachable; `keydown` covers keyboard and AT. Failure direction is "keeps following", which is far better than "silently stops". Asserted deliberately in §6.2 #37 so it is a decision, not an accident. |
| Self-heal re-engages while the user is mid-gesture near the bottom | Transient: the same gesture continuing past the threshold disengages again on the next event. Covered by #25. The alternative — gating self-heal on the session — would break "user scrolls back to the bottom", the primary re-engage path. |
| Instant pin looks abrupt versus the old smooth scroll | It never actually animated at interim-update rates (§3.1); the old code produced lag, not smoothness. Confirm subjectively in G4. |
| Two `useLayoutEffect`s force a synchronous reflow per transcript update | 2–5/s on a bounded-height container. Measure in F1. |
| `overscroll-behavior: contain` changes touch feel on iPad | Deliberate — stops overscroll chaining to the page. Verify in G4 rows 6–8. |
| Breaking changes to the hook's public type (`textBottomRef`, `setIsAutoScrollEnabled`) | Internal workspace package, one consumer each; `tsc --build` in G3 catches both. Removing `setIsAutoScrollEnabled` is deliberate: it makes the §10 T14 stuck path unrepresentable. |
| §3.3 Tier 2 mechanisms remain unproven | The fix does not depend on which is real; the diagnostics counter (§5.5) settles it empirically after the fact, on the actual devices. |
| **Idle re-engage yanks a reader on a touch device**, which has no hover to signal presence (§5.4) | Accepted and documented, not hidden. G4 row 17 checks it on a real iPad, G7b checks it with a screen reader, and `idleReengageMs: null` turns it off per app. The alternative — leaving an unattended kiosk dead for a whole lecture — is worse. |
| Idle re-engage weakens WCAG 2.2.2, since scrolling back is the pause mechanism for auto-updating content | The mechanism is delayed, never removed: the reader can scroll back again immediately, and any presence event resets the deadline. Confirmed rather than assumed by G7b, with a defined remedy (suppress while the region has focus) if it fails. |
| A 3-minute timer is throttled in a background tab | Only delays firing, which is harmless — and arguably right, since a hidden tab has no reader to interrupt. |

---

## 10. Adversarial review log

Reviewed by GLM-5.2 against revision 1. Findings and dispositions:

| Finding | Verdict | Disposition |
|---|---|---|
| **H1** — input events opened a session and blocked pinning; a tap froze captions for 300ms and repeated taps froze them indefinitely; `keydown` unfiltered | **Accepted, serious** | Redesigned as arm-then-open (§4.1, §5.1). Navigation-key filter added. Tests 10/11/12, G0b, G4 step (c). |
| **H2** — scroll anchoring mis-attributed: the anchor sits near the top of the scrollport, this app's shrink is below it | **Accepted** | M1 demoted to Tier 3 with the reasoning recorded. `overflow-anchor: none` retained as insurance, re-labelled in the code comment. |
| **H3** — M3 conflated content-shrink clamping with rubber-banding; from a pinned start the intermediate frames are *beyond* the bottom, so the false positive cannot occur | **Accepted** | M3 **withdrawn**. Content shrink retained only as an input to M6. |
| **H4** — Firefox `msdPhysics` is opt-in, not the default curve | **Accepted** | M5 corrected. |
| **M1** — "out-of-order scroll reports" overstated | **Accepted** | Reframed as a lagging replica read; the test kept as defence-in-depth with honest labelling. |
| **M2** — self-heal re-engage is ungated and can fight a mid-gesture user | **Accepted as a documented trade-off** | Kept ungated (it is the property that kills §3.4); test 25 and a risk-table row added. |
| **M3** — `scroll-behavior: auto` defends against a rule that does not exist | **Accepted** | Rule dropped; `scrollTo({behavior:'instant'})` makes it unnecessary. |
| **M4** — §5.6 viewport hygiene is scope creep | **Accepted** | Split into a separate PR with its own gate. |
| **M5** — one `window` global clobbered by two hook instances | **Accepted** | Label-keyed registry (§5.5); test 38. |
| **M6** — Reduce Motion premise unverified | **Accepted** | Demoted from a G4 pre-check to a non-gate with the caveat stated. |
| **T1–T14** — test gaps | **Accepted** | All folded into §6.2 as tests 10–12, 16–18, 21–22, 26, 30–38. |
| **L3** — listener attach was `useEffect` while the pin was `useLayoutEffect`, leaving a first-mount window | **Accepted** | Both are `useLayoutEffect` now. |
| **L4** — React bailout on `setIsAutoScrollEnabled(true)` not stated | **Accepted** | Noted in the code comment. |
| **L5** — ref-null and ResizeObserver-ordering concerns are non-issues | **Confirmed** | Recorded so they are not re-litigated. |

The review's bottom line — that the core idea (intent gating, distance not
direction, self-heal, instant pin) survives the RCA corrections, but that H1 and
T14 were shippable regressions in the proposed code — is accepted in full.
