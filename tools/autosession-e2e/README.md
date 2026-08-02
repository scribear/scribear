# AUTO-session admin-UI → kiosk pickup check

Answers one question end to end, through the real UI: **does an AUTO-session
window created through the admin console actually reach a live kiosk and a
live viewer?** Not "does the API materialize a session for a window" —
`tools/session-corner-cases` and `tools/demo-e2e` already prove that at the
socket/API level, with hand-built UTC timestamps that bypass the dialog
entirely. This drives the actual "New window" dialog, the actual kiosk, and
watches the actual pickup, the same way `tools/browser-demo-e2e` does for the
on-demand path.

## Why this exists

An earlier ad hoc attempt at this (2026-08-02) left the kiosk sitting idle for
240s after creating a window through the UI, with no way to tell whether that
was a real bug or a bad test. This harness was built to answer that properly —
by reading **server state** at every hop (the admin BFF's own room/windows/
sessions endpoints, and the kiosk's own `my-schedule` long-poll responses over
CDP) rather than trusting rendered text, so a failure names *which* hop broke
instead of just "didn't work within N seconds."

**Result, run 2026-08-02: the pickup path works, and works fast** — a window
created through the real dialog reached a parked kiosk and a live viewer
within ~1s of the session's scheduled start, reproduced across 4 runs. The
earlier inconclusive attempt wasn't a pipeline bug — it hit a real UX bug
instead (see below), since fixed. Full narrative, timing tables, and
recommendations: `~/scribear2/Autosession-e2e-research.md`.

**What it actually found**: "New room" creates every room with
`autoSessionEnabled: false`, and the "New window" dialog said nothing about
it — a window saved the obvious way was stored, listed, and silently produced
zero sessions forever, because the reconciler reads zero windows when the
room's master switch is off. Fixed in `apps/admin-webapp/src/features/scheduling/auto-window-dialog.tsx`
(`49153e0`): the dialog now warns and offers to flip the switch inline.

## Run

```bash
# Needs deployment-iso up (this harness creates/deletes a room and a device —
# don't point it at a stack someone is using). Reads ADMIN_LOCAL_CREDENTIALS
# from deployment-iso/.env by default.
npm run e2e:autosession
```

```bash
# Against a non-default origin/env:
npm run e2e:autosession -- \
  --base-url https://localhost:8443 \
  --env-file ../deployment-iso/.env
```

Takes a little over **10 minutes** by default (phases A and B each wait up to
200s, phase D up to 240s — the wait is long on purpose, to give a slow hop
room to show up rather than reading a slow pass as a failure). Prints a JSON
timeline of every recorded event, a `findings` summary per phase, and the
list of screenshots written.

If a run leaves stray rooms/devices behind (crashed hard enough that the
`finally` cleanup didn't run), sweep them with:

```bash
node tools/autosession-e2e/cleanup.mjs https://localhost:8443 ../deployment-iso/.env
```

(deletes anything named `auto-*`; see the known CSRF issue noted in that
file's header if it reports `403`s).

## What it does, phase by phase

| Phase | What | Proves |
|---|---|---|
| **0** | Log in, register a device, create a room via the real "New room" dialog (defaults untouched), activate the kiosk, then **leave it parked and idle** on `/kiosk/` | Sets up the exact scenario the earlier inconclusive run used — a kiosk already waiting when the window is created, not one that opens the page after |
| **A** | Create an AUTO window through the real "New window" dialog (daily, 00:00–23:59, every day of the week, `activeStart` ~75s out) with every other room setting left at its default | Whether the obvious, UI-default path produces a working window |
| **B** | Flip the room's "Auto-sessions" switch ON in the UI, then watch the same four hops again | Isolates the master-switch effect from everything else |
| **C** | If a session is covering "now": enable the kiosk's mic, mint a join URL from the session detail page, open a viewer, wait for real caption text | The full audio→transcript path, through the UI, on a UI-created window |
| **D** | Delete the window, re-create it with `activeStart` ~75s in the *future* (switch already on) | The kiosk's UPCOMING→ACTIVE transition at a scheduled start, not just its reaction to a window that already covers now |

Each of phases A/B/D polls four hops every 3s and records the first time each
fired (seconds since the phase started), stopping early once all fire:

1. window stored server-side
2. a session covering "now" exists server-side
3. the kiosk's `my-schedule` long-poll delivered a session
4. the kiosk left idle / opened its source socket

## Screenshots

Written to `--screenshot-dir` (default `~/app-screenshots`), prefixed with
`--prefix` (default `autosession`; the 2026-08-02 research run used
`autosession-research`, which is what `SUGGESTIONS.md` and the research doc
reference):

| File | Shows |
|---|---|
| `-00-kiosk-parked-idle.png` | the kiosk waiting before anything is scheduled |
| `-01-scheduling-page-before.png` | the empty scheduling page |
| `-02-new-window-dialog-filled.png` | the filled "New window" dialog — check this against the master-switch warning after `49153e0` |
| `-03-scheduling-page-after-window.png` | the window listed after save |
| `-04-kiosk-after-phaseA.png` | the kiosk at the end of phase A |
| `-05-scheduling-page-auto-enabled.png` | the page right after flipping the switch |
| `-06-kiosk-after-phaseB.png` | the kiosk shortly after the switch flip — this is where it should have gone live before `49153e0`, and does |
| `-07-admin-auto-session-detail.png` | the AUTO session's admin page with the join link |
| `-08-viewer-captions.png` | the payoff: a viewer captioning a UI-created AUTO session |
| `-09-kiosk-streaming.png` | the kiosk producing that audio |
| `-10-kiosk-after-phaseD.png` | the kiosk that went live by itself at the scheduled minute |
| `-zz-failure-*.png` | all three browsers, only written when a run throws |

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--base-url` | `https://localhost:8443` | stack origin (self-signed certs accepted) |
| `--env-file` | `~/scribear2/deployment-iso/.env` | file holding `ADMIN_LOCAL_CREDENTIALS` |
| `--username` / `--password` | from `--env-file` | admin console login |
| `--screenshot-dir` | `~/app-screenshots` | where the PNGs land |
| `--prefix` | `autosession` | screenshot filename prefix |
| `--phase-a-seconds` | `200` | max wait for phase A's four hops |
| `--phase-b-seconds` | `200` | max wait for phase B's four hops |
| `--keep-room` | off | skip the "Delete room" cleanup, for inspection |
| `--headful` | off | visible browsers, for debugging |
| `--skip-captions` | off | skip phase C (mic + viewer), if you only care about materialization/pickup timing |

Chrome is auto-detected from `CHROME_PATH`, then the same candidates as
`tools/browser-demo-e2e` and `tools/e2e-audio`.

## Known limitations

- **Not a pinned pass/fail suite yet.** Unlike `browser-demo-e2e`, this prints
  a timeline and a findings summary rather than asserting named checks with a
  non-zero exit on failure — it started as a research script, not a CI gate.
  Worth adding before relying on it in a pipeline; specific assertions worth
  pinning (from the research doc's R3): `WINDOW_WITH_MASTER_SWITCH_OFF_PRODUCES_NO_SESSION`
  (pins the *server* contract, which is correct and intended),
  `WINDOW_DIALOG_WARNS_WHEN_AUTO_SESSIONS_DISABLED` (regression-tests
  `49153e0`), `PARKED_KIOSK_GOES_ACTIVE_AT_SCHEDULED_START` (phase D; measured
  ~1s, allow ~15s), `AUTO_SESSION_PRODUCES_CAPTIONS_IN_A_VIEWER` (phase C).
- **`cleanup.mjs`'s CSRF extraction has previously 403'd** without a fix
  being tracked down (see its header). The main harness's own per-run
  cleanup, which drives the delete through the real UI, doesn't have this
  problem — `cleanup.mjs` only matters when a run is killed hard enough that
  its `finally` block never runs.
- **`Network.getResponseBody` can lose the body of a long-poll response**
  (a CDP/Puppeteer instrumentation quirk, not product behavior) if it fires
  after the poll has already resolved — the kiosk's rendered state and its
  source-socket-open signal are the reliable delivery proof, not the request
  body capture.
- Two Puppeteer traps worth knowing if you touch this: MUI `Select` opens on
  **mousedown**, so `element.click()` via `page.evaluate` does nothing (use a
  real `page.click`); and the admin app bar's own "Show UUIDs" switch is
  *first in document order*, so a bare `.MuiSwitch-input` selector can
  silently toggle the wrong control — scope to the card whose text contains
  what you're looking for.
