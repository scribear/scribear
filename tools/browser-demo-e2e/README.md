# Browser demo end-to-end check

Drives the **entire** demo — operator, kiosk and audience member — through three
real Chromium windows, and asserts what a human would actually see. It is the
browser counterpart to `tools/demo-e2e`, which checks the same journey at the
socket level and cannot see a single pixel.

Every step that a person performs in the runbook is performed here by clicking
the real control: logging into `/admin/`, **Register device**, **New room**,
typing the activation code into the kiosk, **Start a session now**, **Open live
captions**, and **End early**. Nothing is provisioned behind the UI's back.

## Why

The fixes this pins are _rendering and timing_ changes, and two of them are
invisible to every other check in this repo.

**The banner.** A healthy room that nobody is talking into yet used to render as
_"Connection to the transcription service was lost. Reconnecting…"_ — a warning,
coloured and announced as a fault, and it stayed up forever. That is why the
demo "was always showing reconnecting" while the backend was entirely healthy,
and why the hardcoded Alice room looked fine (its synthetic source hardcodes
both status flags `true`). Unit tests pin the pure derivation function, but the
thing that failed in the room was a rendered banner, so this asserts the
rendered banner: the exact string, and `role="status"` rather than
`role="alert"`.

**The token-refresh timer.** `decodeSessionTokenExpiryMs` used to read the wrong
segment of a ScribeAR session token (two segments, payload first — not a JWT),
so it always returned `null` and the proactive refresh timer was **never armed**
on any connection, ever (fixed in `8ff4582`). Session tokens live **5 minutes**.
Any check shorter than that — which is every other check here — cannot tell the
fixed build from the broken one. So this one holds a viewer open past the token
lifetime with audio flowing and watches for a reconnect that must not happen.

## Run

```bash
# Needs the stack up. Reads ADMIN_LOCAL_CREDENTIALS from deployment/.env.
npm run e2e:browser-demo
```

```bash
# Against a stack on a non-default origin, e.g. an isolated deployment:
npm run e2e:browser-demo -- \
  --base-url https://localhost:8443 \
  --env-file ../deployment-iso/.env
```

Takes a little over **9 minutes** by default and that is deliberate: the
long-lived window has to outlast a 5-minute token. Exits non-zero and names the
failing assertion. `--json` emits the result, the artifacts (room/session uid,
join URL) and the client's network counters as JSON.

## What it checks

| #   | Assertion                                   | What a failure means                                                                  |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `ADMIN_LOGIN_VIA_UI`                        | the admin console's real login form is broken                                         |
| 2   | `DEVICE_REGISTERED_VIA_UI`                  | the Register device dialog no longer shows the activation code                        |
| 3   | `ROOM_CREATED_VIA_UI`                       | New room, or its async source-device picker, is broken                                |
| 4   | `KIOSK_ACTIVATED_VIA_UI`                    | the kiosk's activation form does not bind a device                                    |
| 5   | `SESSION_STARTED_VIA_UI`                    | "Start a session now" no longer lands on the session detail page                      |
| 6   | `JOIN_URL_FROM_SESSION_PAGE`                | the lazy join-code mint is broken — no viewer can be invited                          |
| 7   | `VIEWER_JOINED_VIA_URL`                     | the `#config=` handoff or the join-code exchange is broken                            |
| 8   | **`IDLE_BANNER_IS_INFORMATIONAL`**          | **the idle room no longer reads "Waiting for the room's microphone to connect."**     |
| 9   | **`IDLE_BANNER_NOT_A_FAULT`**               | **the idle banner says "reconnecting", or is `role="alert"` — the original demo bug** |
| 10  | `BANNER_CLEARS_WHEN_AUDIO_FLOWS`            | the banner is sticky: it stays up after the room gets a microphone                    |
| 11  | `TRANSCRIPT_RENDERED_IN_BROWSER`            | audio reached a provider but nothing reached `role="log"`                             |
| 12  | **`LONG_LIVED_VIEWER_NEVER_RECONNECTS`**    | **the viewer opened a second socket — a reconnect, i.e. the dead-timer regression**   |
| 13  | **`TOKEN_REFRESH_TIMER_ARMED`**             | **zero `refresh-session-token` calls in >5 min: the timer is not armed (`8ff4582`)**  |
| 14  | `TRANSCRIPTS_STILL_FLOWING_AFTER_TOKEN_TTL` | captions died at the token boundary even without a visible reconnect                  |
| 15  | `SESSION_END_RETURNS_VIEWER_TO_JOIN_PROMPT` | ending the session hangs the viewer instead of returning it to the join prompt        |

8, 9, 12 and 13 are the reason this exists. The rest are there so that a failure
in them is not misread as a failure in those four.

## Screenshots

Written to `--screenshot-dir` (default `~/app-screenshots`), prefixed with
`--prefix` (default `browser-demo`):

| File                                  | Shows                                                                 |
| ------------------------------------- | --------------------------------------------------------------------- |
| `-00-admin-session-detail.png`        | the operator's session page with the join code and live-captions link |
| `-01-idle-waiting-for-microphone.png` | **the headline fix**: a blue, `info`-styled waiting banner            |
| `-02-captions-flowing.png`            | captions on screen and **no banner at all**                           |
| `-02b-kiosk-streaming.png`            | the kiosk that is producing that audio                                |
| `-03-long-lived-viewer.png`           | the same viewer >6 minutes later, still captioning                    |
| `-04-session-ended-join-prompt.png`   | the viewer back at the join prompt after End early                    |
| `-zz-failure-*.png`                   | all three browsers, only written when a run fails                     |

These are the deliverable a human reads. A passing exit code says the strings
matched; the screenshot says the room looked right.

## Options

| Flag                   | Default             | Meaning                                                        |
| ---------------------- | ------------------- | -------------------------------------------------------------- |
| `--base-url`           | `https://localhost` | stack origin (self-signed certs are accepted)                  |
| `--env-file`           | `deployment/.env`   | file holding `ADMIN_LOCAL_CREDENTIALS`                         |
| `--username`           | from `--env-file`   | admin console user                                             |
| `--password`           | from `--env-file`   | admin console password                                         |
| `--screenshot-dir`     | `~/app-screenshots` | where the PNGs land                                            |
| `--prefix`             | `browser-demo`      | screenshot filename prefix                                     |
| `--warmup-seconds`     | `45`                | audio streamed before the long-lived window opens              |
| `--long-lived-seconds` | `400`               | the long-lived window; **must exceed 300 s** or #13 is vacuous |
| `--keep-room`          | off                 | skip the "Delete room" cleanup                                 |
| `--headful`            | off                 | visible browsers, for debugging                                |
| `--json`               | off                 | machine-readable result                                        |

Chrome is auto-detected from `CHROME_PATH`, then `/usr/bin/google-chrome-stable`,
`google-chrome`, `chromium-browser`, `chromium` — same as `tools/e2e-audio`.

## Notes

- **Three browsers, not three tabs.** They model three machines. The kiosk and
  the client are served from the same origin, so one browser would have them
  sharing `localStorage` and cookies — which is not how any of this is
  deployed, and would let a kiosk bug hide behind client state.
- **The kiosk is parked (`about:blank`) between activation and the session.**
  It has to be: `sourceDeviceConnected` flips true when the kiosk opens its
  source socket, which it does the instant a session goes active. A kiosk left
  on the page would race the viewer and the idle banner would never be
  observable. The device stays activated across the park — activation codes are
  single-use, so re-activating is not an option.
- **Navigate straight to the join URL.** Loading `/client/` and _then_ going to
  `/client/#config=…` looks equivalent and is not: a fragment-only change is a
  same-document navigation, the app never re-initializes, and the config
  middleware — which runs once, on redux-remember rehydration — never sees the
  code. The viewer silently sits on the join prompt.
- **The microphone control is a toggle**, so the script clicks and then
  _verifies_ binary frames are on the wire, rather than clicking a fixed number
  of times.
- **Audio** comes from Chrome's fake capture device fed by
  `test_audio_files/speech/harvard_16k_mono.wav` (33 s, looped by Chrome), so a
  ten-minute run needs no real microphone and stays deterministic.
- **`…/transcription-stream/undefined/client`.** The client opens one socket
  with a literal `undefined` session uid at startup, before it knows its
  identity, and aborts it immediately. It is counted separately from real
  sockets so it cannot be mistaken for a reconnect in assertion 12. It is
  harmless but it is also noise in every browser console — worth removing.
- **Ending a session returns the viewer to the join prompt without saying
  why.** Assertion 15 passes (the viewer does not hang, which is what
  `bc37f92`'s end-watch fixes), but the client renders no "this session has
  ended" message — it just reopens the join dialog. The run records whatever
  explanation _was_ shown in that check's detail, so a future fix has a
  baseline. This is the same "cause, audience, next action" gap catalogued in
  `2026-08-01-02-PLAN-VisibleErrors.md`.
- **Cleanup deletes the room through the UI** ("Delete room" on the room detail
  page), which cascades the session. `--keep-room` leaves it for inspection.
