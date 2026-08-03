# In-browser translation end-to-end check

Runs the real `TranslationService` against **Chrome's real Translator API** in a
real Chrome window, and asserts what a reader would actually see: Spanish text,
an ellipsis where captions were dropped, and a visible error when translation
stops answering.

## Why

The unit tests in `libs/store/live-translation-store` drive a fake
`self.Translator`. That makes them fast and deterministic, but it also means
they pin our logic against *our belief* about the browser API — and the belief
is the risky part. The API is young, ships behind flags, downloads models over
the network, and its failure modes are largely undocumented. Every assertion
here is a claim the fake cannot check.

Two behaviours in particular are invisible to any non-browser test:

**A cold profile cannot translate, and does not say why.** The per-pair model
downloads on demand, but the `Chrome TranslateKit` *library* component arrives
separately, on the component updater's own schedule — measured at roughly 80
seconds after first launch on this repo's machine. Until it lands, `create()`
rejects with `NotSupportedError` and logs "Failed to load the translation
library", which is indistinguishable from an unsupported language pair. There
is no event, no progress, and no API that reports that component's arrival, so
the warm-up here retries for minutes rather than failing on the first error.
This is also why the profile is persisted: a warm profile is ready instantly.

**Identity pairs are rejected.** `en` → `en` reports `unavailable` and throws
`NotSupportedError`, contradicting the spec, which says identity translation is
always available. The check uses it deliberately: it is the cheapest real
failure available and it drives the entire error-reporting path against real
Chrome.

## Run

```bash
npm run e2e:translation

# first run on a cold profile can take several minutes
npm run e2e:translation -- --warmup-seconds 600

# CI on a machine that may never get a model
npm run e2e:translation -- --skip-if-unavailable
```

Options: `--profile <dir>`, `--language <tag>`, `--warmup-seconds <n>`,
`--headful`, `--skip-if-unavailable`, `--json`.

## Requirements

Real **Google Chrome ≥ 138**, found via `CHROME_PATH` or the usual system
locations. Chromium, Chrome for Testing and Playwright's bundled browser all
ship without the Optimization Guide components, so `Translator` is simply not
there and the check fails at its first assertion. Microsoft Edge exposes the API
but its translation service crashes on Linux.

The harness is served over `http://localhost` because the API is only exposed in
a secure context — it is absent on `about:blank` and on `file://`.

## Notes

- **The artificial delay is not a mock.** Backpressure and the 20-second
  timeout only trigger when translation cannot keep up, and a warm `en`→`es`
  model on a desktop never falls behind on its own. The harness therefore wraps
  the real `translate()` with a delay to simulate a loaded device — the
  translation underneath is still Chrome's, and the assertions are about our
  queue behaviour under real latency.
- **`no-uncaught-errors` is the important one.** Translation is an optional
  feature layered on top of an accessibility tool. If the browser API fails and
  the exception escapes, it takes the transcript down with it. That check is
  what says it does not.
- The harness bundles `@scribear/live-translation-store` through the
  `development` export condition, so it tests the source in the repo rather
  than a stale `dist`.
