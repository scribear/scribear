# Transcript / summary export end-to-end check

Drives the real export code in a real Chrome window and asserts what lands on
disk: a `transcript-YYYYMMDD-HHMMSS.txt` holding the transcript, and — where the
machine can run the model — a `summary-YYYYMMDD-HHMMSS.txt` that says on its
first screen that it was generated locally.

## The feature is currently switched off

`IS_SUMMARIZATION_ENABLED` in
`libs/store/transcript-export-store/src/config/feature-flags.ts` is `false`, so
the app offers no summary controls. This tool **force-enables** the service
(`new SummarizationService({ enabled: true })`) because its job is to keep the
machinery behind that switch working, so turning it on later is a one-line
change rather than an excavation. The switched-off behaviour is pinned by unit
tests instead.

## Why

**A download is not a function call.** `downloadTextFile` builds a `Blob`, mints
an object URL, clicks a detached anchor and revokes the URL a minute later. Unit
tests stub every one of those, so they can only check that we called our own
code. Whether a file with the right name and the right bytes actually reaches
the disk is a question about Chrome — including the revoke timing, which if done
synchronously cancels the download it just started.

**Summarization availability is a property of the machine, not the browser.**
`Summarizer` exists as an object on hardware that cannot host Gemini Nano. There
`availability()` answers `"unavailable"` and every `create()` fails with _Unable
to create a text session because the service is not running_. So the summary
checks branch:

- On a capable machine, the real model runs over a 30,000-character transcript —
  which does not fit one request — and the recursive reduction is exercised for
  real.
- On a machine that cannot, the check asserts the **withholding**: that the
  service reports itself `UNSUPPORTED` rather than offering a button that could
  only fail. That is not a skip; it is the branch most users are on, and getting
  it wrong is the worst outcome the feature has.

## Run

```bash
npm run e2e:export

# first run on a capable machine downloads ~1.8 GB
npm run e2e:export -- --summary-timeout 1800

# keep the files to look at
npm run e2e:export -- --download-dir ~/scribear-export-check
```

Options: `--profile <dir>`, `--download-dir <dir>`, `--summary-timeout <n>`,
`--headful`, `--json`.

## Requirements

Real **Google Chrome ≥ 138**, found via `CHROME_PATH` or the usual locations.
The transcript checks run anywhere Chrome does. The real-model checks need the
Gemini Nano requirements met: roughly 22 GB free disk on the profile's volume,
and either >4 GB VRAM or 16 GB RAM with 4+ cores.

Measured on this repo's Linux machine (Chrome 151, 62 GB RAM, 20 cores, 225 GB
free, RTX 5070 Ti): the Translator API works, but the foundation-model service
never starts — `Summarizer.availability()` is `"unavailable"` and `create()`
throws _Unable to create a text session because the service is not running_.

The cause is visible on `chrome://on-device-internals` (enable it first via the
button on `chrome://chrome-urls`):

```
Device performance class:  Loading...        <- never resolves
Foundational model state:  NO STATE
Foundation model criteria is not available yet.
```

Chrome benchmarks the machine to assign it a performance class, and the
foundation model is only eligible once that lands. Here it never does, so
`availability()` answers `"unavailable"` forever. It is an outright refusal, not
a slow start: while "waiting", the NetworkService transfers **zero** bytes, CPU
sits flat at 0.2%, and no model directory ever appears — a long timeout buys
nothing.

Seven configurations were tried and all gave the identical answer, so please
don't repeat them: headless; headed under `Xvfb`; `--use-angle=vulkan
--enable-features=Vulkan`; `--use-gl=angle --use-angle=gl
--ignore-gpu-blocklist`; `--optimization-guide-on-device-model-execution-override`;
`compatible_on_device_performance_classes/*`; and both overrides together.
Freeing the GPU entirely (15.8 GB of 16 GB free, versus 3.8 GB) changed nothing
either, so VRAM is not the gate. There is no enterprise policy on this box.

The `stubbed-model` checks below exist because of exactly this.

## The `stubbed-model` checks

Two checks install a stand-in `Summarizer` in the page via `?stub=1`. **They are
not a test of Gemini Nano.** They exist so the parts around the model — the
recursive reduction, the file builder, the real `Blob`, the real download —
are exercised in a real browser on machines that cannot host it, which is most
of them.

The stub enforces Chrome's real 9216-token quota using the token cost measured
from the real API (`≈ 560 + 0.209 × chars`, fitted to samples in
`tools/browser-ai/WebAPISummarizer-Dev.md`), so a chunk size that production
would
reject is rejected here too.
