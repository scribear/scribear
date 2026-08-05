# @scribear/metrics-overlay-ui

## 0.3.0

### Minor Changes

- c36e5de: Metrics overlays are now opt-in, not always on; translation has one of its own;
  and the kiosk gets both.
  - **Hidden by default.** The latency badge no longer sits over every reader's
    captions. It appears only when the URL fragment asks for it:
    `#metrics=latency`, or `#metrics=all` for every overlay. The value is a
    comma-separated list (`#metrics=latency,foo`) so further overlays can be added
    without another fragment parameter; unknown names are ignored rather than
    rejected, so a link written for a newer build still works on an older one.
  - **`m` toggles.** Pressing `m` shows or hides the overlays at any time — with
    no fragment at all, `m` reveals everything, so a plain link can still be
    diagnosed on the spot. The key is ignored when another handler already claimed
    the event, when a modifier is held, or when focus is in a text field (typing
    `m` into the join-code box types an `m`).
  - Parsing reads the fragment with `URLSearchParams`, so `metrics` coexists with
    other fragment parameters and leaves the existing `#config=<base64>` payload
    the url-config middleware consumes untouched.
  - **The badge itself is now a labelled table** — rows `Pipeline` / `End-To-End`,
    columns `Final` / `Interim`, with the unit named once in the corner cell —
    instead of four bare numbers separated by slashes, and it sits centered along
    the top rather than in the top right, where it covered the header controls.
  - **New `#metrics=translation` overlay.** Rows `Wait` (queue time) / `Translate`
    (the model call) / `Total`, columns `Last` / `Avg` over the same 60-sample
    window the transcription figures use, with a footer carrying the translator
    status, the current backlog, the dropped-caption count, and how many calls
    have been measured. Wait and the call are split because they fail differently:
    wait growing means the model cannot keep pace with the room, the call growing
    means individual requests got slower. Shown whenever the browser can translate
    at all — including with translation off, so the overlay says why there is no
    data rather than disappearing.
  - **Both overlays on the kiosk too.** Same fragment, same `m` key, same cards.
    The kiosk had been receiving the node's latency updates and discarding them
    ("the source device does not display latency") — it now records them, which
    matters because the kiosk is the device whose clock sync makes end-to-end
    latency measurable at all, and the one standing in the room where a lagging
    translation gets noticed.
  - **New `@scribear/metrics-overlay-ui` package.** The fragment parsing, the `m`
    shortcut, the overlay container and the cards live there, presentational and
    store-agnostic like the other UI libraries; each app keeps a thin container
    that wires its own selectors.
  - **Translation service — latency instrumentation.** `TranslationService` now
    emits a `sample` event (queue wait, call duration, captions covered, backlog
    left) after each `translate()` that produced text, and counts dropped captions
    rather than only flagging that some were dropped — the on-screen gap markers
    coalesce, so one ellipsis could stand for a fragment or for a minute of
    speech. Both are mirrored into the store by the live-translation middleware
    and reset when a new session clears the captions.
