# Adversarial code review — PR #211 (`fix/autoscroll-scrollback-detection`)

Reviewed against `staging...fix/autoscroll-scrollback-detection` (commits
`281c7e1`, `951b6c5`, `43bb2ca`). I read the hook, the diagnostics module, both
caption components, the three app roots, the e2e, the plan doc, and the test
suite; I also ran the unit suites (81 + 30 passing), lint, `tsc --build` for
both libs, and `tsc -b && vite build` for all three apps — all green.

## Verdict

Ship-blocking: **none.** This is a careful, well-reasoned rewrite and the
self-reviewed regressions (H1, T14, the open-session-at-the-bottom bug) are
genuinely fixed and pinned by tests. The findings below are a test gap, two
behavioural inconsistencies between the two caption regions, one a11y risk the
plan itself flags as unresolved, and a set of lower-severity items. The one
thing I would insist on before merge is **F1** (the missing test for the
mid-session `idleReengageMs` change), because the second commit *claims* it
fixed that bug and there is nothing executing against it.

---

## Findings

### F1 — The `idleReengageMs`-while-disengaged fix has no test  (test gap, medium)

The second commit ("close the scroll session when the reader reaches the
bottom") lists as a fixed defect:

> Changing `idleReengageMs` while disengaged tore down the idle timer without
> restarting it.

The fix is real and correct: the listener effect re-runs when `restartIdleTimer`
changes (it is in the dep array at `use-auto-scroll.ts:493`), its cleanup calls
`clearIdleTimer`, and the body re-arms via `if (!engagedRef.current)
restartIdleTimer()` at `use-auto-scroll.ts:466`.

But no test exercises it. `use-auto-scroll.idle.test.tsx` renders the hook once
with a fixed `idleReengageMs` and never re-renders with a new value (grep finds
only `setup({ idleReengageMs: … })` calls and the `46: null disables it` case).
So the regression described in the commit message — change the delay while
disengaged → timer silently dropped — would currently pass CI if reintroduced.

**Recommendation:** add a case that disengages, advances partway to the
deadline, re-renders the harness with a different `idleReengageMs`, and asserts
the new deadline (not the old one, and not "never") governs the fire. This is
the same harness shape already used for case 22 (mid-session `lineHeightPx`
change), so it is cheap.

### F2 — `TranslatedCaptionsPanel` won't re-pin when `lineHeightPx` changes  (behavioural inconsistency, low–medium)

`translated-captions-panel.tsx:80` wires the hook with only `[segments]` as
dependencies:

```tsx
useAutoScroll([segments], { lineHeightPx, label: 'translation', idleReengageMs });
```

The transcript container, by contrast, passes
`[commitedSections, activeSection, inProgressTranscriptionText, containerHeightPx, displayHeightPx]`
(`transcription-display-container.tsx:113`), where `displayHeightPx =
numDisplayLines * lineHeightPx` — so a font-size change reaches the pin effect
and the view re-pins against the reflowed content.

The translated panel does not. When a reader bumps the caption size while the
panel is engaged, `scrollbackThresholdPx` recomputes inside the hook (so the
*disengage* threshold moves correctly) but the *pin* effect does not re-run
until the next translated segment arrives. During a pause in speech the panel
sits one line-height off the new bottom until speech resumes. The apps pass a
live `lineHeightPx` (a user preference) and no `displayHeightPx` (defaults to
160, constant), so this is reachable in production.

**Recommendation:** add `lineHeightPx` (and `displayHeightPx` if it can vary)
to the panel's dependency array, or document why it is deliberately omitted.
Matching the transcript container's wiring is the lower-risk choice.

### F3 — `TranslatedCaptionsPanel` shows a scrollbar; the transcript doesn't  (visual inconsistency, low)

The transcript container hides the scrollbar three ways
(`transcription-display-container.tsx:174`): `&::-webkit-scrollbar: { display:
'none' }`, `msOverflowStyle: 'none'`, `scrollbarWidth: 'none'`. The translated
panel (`translated-captions-panel.tsx:170`) sets `overflowY: 'auto'` and none of
the hiding rules. On a desktop browser the translated strip therefore shows a
native scrollbar in a 160px-tall region — a visible fraction of the panel, and
inconsistent with the pane above it. (On the kiosk target this is moot — no
scrollbar — but the client/standalone run on desktops.)

**Recommendation:** apply the same three scrollbar-hiding rules to the
translated panel, or lift them into a shared style.

### F4 — Idle re-engage ships without the screen-reader confirmation the plan says is required  (accessibility risk, medium — but see note)

The plan (§5.4, §9 risks) is explicit that WCAG 2.2.2 (Pause, Stop, Hide) is
weakened by a timer that revokes a scrollback, and that the remedy is "confirmed
rather than assumed by G7b, with a defined remedy (suppress while the region has
focus) if it fails." The PR's own "Not done" list concedes G7b is not done, yet
all three apps opt in to `idleReengageMs: 180_000` by default.

So we are shipping the behaviour the plan said should not ship unconfirmed. The
defined remedy (suppress the idle timer while the caption region contains focus)
is not implemented; only `focusin` as a presence-reset is. A VoiceOver user
parked in the translated transcript, not moving focus, reading history for three
minutes, will be yanked to the bottom — exactly the case the plan calls out.

**Recommendation:** either (a) land G7b before merge — at minimum, suppress the
idle timer while `document.activeElement` is within the caption region, which is
a small change to `restartIdleTimer`'s guard — or (b) default `idleReengageMs`
to `null` on the personal apps (client, standalone) until G7b is done, keeping
`180_000` only on the kiosk where the unattended-display trade-off is
 strongest. The plan already says "a future app should have to think about it";
 defaulting all three to the same value collapses that decision.

### F5 — The `dependencies` constant-length footgun is real and unguarded at the type level  (maintainability, low)

The JSDoc on `useAutoScroll` (`use-auto-scroll.ts:166`) warns that the
`dependencies` array must keep a constant length. I verified this against the
actual React 19 source in `node_modules`:

```js
// react-dom-client.development.js:7611
nextDeps.length !== prevDeps.length &&
  console.error("…changed size between renders…");
for (var i = 0; i < prevDeps.length && i < nextDeps.length; i++)
  if (!objectIs(nextDeps[i], prevDeps[i])) return !1;
return !0;
```

So the warning is accurate: a length change compares only the shared prefix and
returns `true` (effect skipped), with a dev-only console error. In production
the extra dependency is **silently ignored** — re-pinning stops. The two
shipped callers pass constant-length arrays, so this is not a live bug, but the
signature `dependencies: unknown[]` provides zero compile-time protection, and
the spread `[...dependencies, isAutoScrollEnabled, scrollToBottom]` makes the
trap invisible at the call site. A future maintainer adding a sixth entry to the
container's array would not see a type error.

**Recommendation (optional):** this is hard to enforce in TS without variadic
tuples, but a one-line runtime dev assert (`if (dependencies.length !==
prevLen.current) console.error(...)`) inside the hook would make the footgun
loud in dev for every consumer, not just the ones who read the JSDoc.

### F6 — `isOwnScroll` is coupled to `behavior: 'instant'` updating `scrollTop` synchronously  (design coupling, low — documented)

The own-scroll guard (`use-auto-scroll.ts:335`) treats a scroll event as ours
only when `distanceFromBottom <= PIN_TOLERANCE_PX` *and* within the grace
window. This is robust *because* `scrollTo({ behavior: 'instant' })` updates
`scrollTop` synchronously to the new bottom before the (possibly async) scroll
event fires — so a pin's own echo always reports `distance ≈ 0`. I traced the
alternative where content grows between the pin and the echo: it does not
defeat the guard, because each content-growth commit triggers a fresh pin that
re-sets `scrollTop` to the latest bottom, so the echo still lands at the bottom.

The coupling is worth noting because it is load-bearing: if a future change
switched the pin to `behavior: 'smooth'` (or to `scrollIntoView`), `scrollTop`
would no longer be at the bottom when the echo fires, the `distance <=
PIN_TOLERANCE` half would fail, and — combined with a recent tap arming the
window — the pin's own echo could open a user session and block the next pin.
That is the H1 regression in another hat. The comment at `:213` does say
"smooth … only adds lag" but does not say "and would break the own-scroll
guard." Worth a sentence.

### F7 — Idle-fire path duplicates `engage()` instead of calling it  (style/clarity, low)

The idle timer's fire callback (`use-auto-scroll.ts:296`) manually does:

```ts
lastIdleResetAtRef.current = Number.NEGATIVE_INFINITY;
closeUserScrollSession();
engagedRef.current = true;
setIsAutoScrollEnabled(true);
```

This is exactly `engage()` (`:264`) plus `closeUserScrollSession()`, minus
`clearIdleTimer()` — which is a no-op here anyway because `idleTimerRef` was set
to `null` two lines above. Calling `engage()` (and `closeUserScrollSession()`)
would be equivalent and would keep one code path for "become engaged," which is
the stated design goal ("one code path responsible for the scroll offset" is
already in the comment). Minor, but the duplication is a place for the two
paths to drift.

### F8 — Changing `idleReengageMs` mid-gesture tears down the open session  (edge case, low)

Because `restartIdleTimer` is in the listener effect's dependency array
(`:493`), changing `idleReengageMs` runs the effect cleanup, which calls
`closeUserScrollSession()` (`:489`) — wiping the arm and clearing the settle
timer. If a reader happened to be mid-drag when the prop changed, their
in-flight gesture would lose attribution and subsequent scroll events would be
suppressed until they re-armed. In practice `idleReengageMs` is a module-level
constant in all three apps, so this is unreachable today; flagging it only
because the hook accepts the prop as dynamic and F1 above will exercise
mid-session changes.

### F9 — `fake-scroller.ts` is duplicated across the two lib test trees  (maintenance, low)

`libs/ui/transcription-display-ui/tests/fake-scroller.ts` and
`libs/ui/live-translation-ui/tests/fake-scroller.ts` are near-identical (the
latter is a trimmed copy with an added `contentHeight` getter). The
justification (a package's `tests/` is not a public export) is reasonable, but
the two copies have already diverged slightly and will drift further. If a
behavioural bug is found in one, it will not propagate to the other.

**Recommendation (optional):** extract to a `@scribear/test-utils` dev-only
package, or add a `dev` export condition to `transcription-display-ui` that
exposes the fake scroller. Not blocking.

### F10 — Diagnostics registry publishes the live counters object  (consistency, low)

`auto-scroll-debug.ts:124` publishes the live `counters` object reference, not a
snapshot, so `window.__scribearAutoScroll[label]` is always current (good for
the e2e), but `getDiagnostics()` (`use-auto-scroll.ts:411`) returns a snapshot
clone. The two APIs for the same data have different aliasing semantics. Not a
bug — the e2e spreads the object before reading — but a caller reaching for the
global and mutating it would corrupt the counters. A `snapshot()` on read (or
`Object.freeze`) on the global would make the two consistent.

---

## Things I specifically tried to break and could not

- **Tap-then-pin attribution loop** (the H1 regression): a `pointerdown` that
  arms, followed by caption updates whose pin echoes land inside/outside the
  grace window, never opens a durable session, because the echo either is
  `isOwnScroll` (within grace, at bottom) or hits the ungated at-bottom branch.
  Confirmed by reading tests 10/11 and tracing the async-echo case.
- **The open-session-at-the-bottom freeze** (the 23b headline bug): without
  `endUserScrollSession()` in the at-bottom branch the pin effect would decline
  for the settle window; with it, the session closes and the next pin runs.
  Test 23b fails without the fix, as claimed.
- **Per-event vs per-gesture disengage counting**: the `engagedRef` transition
  gate at `:381` correctly collapses a multi-frame flick to one
  `recordUserDisengage` (test 22b).
- **StrictMode mount/unmount/remount**: `register`/`dispose` symmetry in
  `auto-scroll-debug.ts:122` survives the double-invoke; the `installedRef`
  guard in the lifecycle test harness prevents a double scroller install. Test
  35 passes.
- **`scrollend` grace vs settle race**: a user `scrollend` arriving within
  `PROGRAMMATIC_SCROLLEND_GRACE_MS` of a pin is suppressed, but pins do not run
  while a user session is open, so a genuine user `scrollend` (which only fires
  after the user scrolled) is never in the grace window in practice. Tests 33/34
  hold.
- **Two instances sharing the global**: the label-keyed registry and the
  `registry[label] === counters` identity check in `dispose` prevent the
  last-mounted instance from clobbering the first's entry on unmount. Test 38.

## Residual risk I want to call out explicitly

The plan and the PR description are both honest that **no real-device testing
has been done**, and that the WebKit/iOS mechanisms (M2 lagging replica, M4
rubber-band, momentum scroll) are untested because the puppeteer e2e is Blink.
The fix is engine-agnostic *by construction* (attribution gating does not
depend on which engine moved `scrollTop`), and that reasoning is sound — but it
is reasoning, not evidence. The `suppressedDisengagements` counter is the
mechanism that turns this into evidence post-merge; please make sure the
10-minute instrumented soak on real hardware (G4) actually happens before
declaring #209 closed.

---

## Suggested merge conditions

1. **F1**: add the mid-session `idleReengageMs` test (blocks merge — claimed fix
   with no coverage).
2. **F4**: decide explicitly between (a) landing the focus-suppression remedy or
   (b) defaulting the personal apps to `null` until G7b. Do not ship all three
   apps at `180_000` with the a11y check still in "Not done."
3. **F2 / F3**: fix or consciously defer; both are small.
4. F5–F10: optional / follow-up.
