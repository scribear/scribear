# @scribear/transcription-display-ui

## 0.3.0

### Patch Changes

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

## 0.2.0

## 0.1.0
