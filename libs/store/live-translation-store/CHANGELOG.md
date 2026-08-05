# @scribear/live-translation-store

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

- 2df4286: Add opt-in translated captions, produced in the browser by Chrome's Translator
  API, to the client and kiosk webapps.

  The transcript is never replaced. Translated text renders in its own panel below
  the original, because machine translation of live speech is unreviewed by anyone
  and the source has to stay available to whoever needs to check what was actually
  said — and it is what a later summarisation pass would run against.

  **Only finalized captions are translated.** Interim ASR output is rewritten
  several times a second; translating it would spend the model's entire throughput
  producing text that is about to be replaced, and would put half-finished
  sentences in front of a reader.

  **The feature is absent, not disabled, on browsers without the API.** A
  `Translator` that is missing means the user has no path forward, so the menu,
  the dialogs and the panel are all omitted. Everything reaching the browser API
  is wrapped: `TranslationService` never throws and never rejects, because it is
  an optional feature layered on top of an accessibility tool and a failure inside
  it must not take the transcript down with it.

  **Gates.** Turning translation on or off is confirmed first, and the
  confirmation states both that the output may contain errors and — when the
  model is not yet on the device — that proceeding starts a one-time download.
  `enable()` is invoked synchronously inside the dispatch so it still carries the
  click's user activation, which Chromium requires before a downloading
  `create()`. A persisted "on" preference auto-resumes **only** when the model is
  already available locally; otherwise translation stays off and the user is asked
  again, so a stored preference cannot silently spend a metered connection on page
  load. The same reasoning keeps `isTranslationEnabled` out of URL config: a link
  must not be able to skip the disclaimer on a reader's behalf.

  **Falling behind is visible, not silent.** Captions that have waited more than
  20 seconds are dropped so the display can catch up with the room, and the loss
  is marked with an ellipsis rather than closing the gap invisibly. A translation
  that does not return within 20 seconds is a failure, not slowness: it is aborted
  and reported as "No translations are available."

  Also adds two props to `TranscriptionDisplayContainer`: `announceUpdates`, so
  the original region stops announcing while the translated one does (two live
  regions carrying the same speech announce it twice and make both unusable), and
  `fillParentHeight`, so the two caption regions divide one viewport instead of
  each claiming all of it.

  Pinned by unit tests against a scriptable fake API, and by
  `npm run e2e:translation`, which runs the real service against real Chrome —
  including real Spanish output, the ellipsis under real backpressure, and the
  20-second timeout.
