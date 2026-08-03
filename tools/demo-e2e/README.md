# Two-room demo end-to-end check

Provisions two **real** rooms against a running stack, streams real audio into
each from a headless source device, and asserts that a real viewer socket — one
that joined with a join code, exactly as a browser does — sees the room come out
of idle and produce captions.

Unlike `tools/e2e-audio` and `tools/admin-scheduling-e2e`, this drives no
browser. It is the socket-level counterpart: everything a demo needs, minus the
rendering. It also doubles as the provisioning script for a live demo — see
`--hold`.

## Why

The demo this was written for failed with every real room stuck on
_"Reconnecting…"_ while the backend was entirely healthy. The hardcoded Alice
demo room worked, and every unit and integration test passed, so nothing pointed
at the fault. The cause was that the **idle** state — `sourceDeviceConnected:
false`, which is what a room looks like before anyone starts talking — was
rendered as a lost connection, and the demo room was immune because its
synthetic caption source hardcodes both status flags to `true`.

Nothing in CI can see that, because seeing it requires a room somebody just
created, a source that connects _after_ a viewer is already watching, and an
observer of the `sessionStatus` sequence. That is what this is.

So the assertions are about the **status transitions**, not only about
transcript text:

| #   | Assertion                                              | What a failure means                                                                                |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | viewer gets `authOk`                                   | join-code exchange or the `/client` route is broken                                                 |
| 2   | the first `sessionStatus` is idle (both flags `false`) | the seed state changed; the "not yet known" case is being conflated again                           |
| 3   | `sourceDeviceConnected` goes `false` → `true`          | the headless source never registered                                                                |
| 4   | `transcriptionServiceConnected` goes `false` → `true`  | node-server never reached a provider (or was refused — see capacity below)                          |
| 5   | the source flag **led** the service flag               | node-server dials the upstream from `registerSource`; the reverse order means that contract changed |
| 6   | a `transcript` arrives with non-empty `final.text`     | audio reached a provider but produced nothing                                                       |

Room A exercises an **on-demand** session; room B exercises an **AUTO** session
materialized from an auto-session window covering now. Both paths matter and
they fail differently.

## Run

```bash
# Needs the stack up, and a built repo (`npm run build`) — the source device is
# the real @scribear/test-audio-source engine, not a copy of it.
npm run e2e:demo
```

```bash
node tools/demo-e2e/demo-e2e.mjs \
  --base-url https://localhost \
  --rooms 2 \
  --stream-seconds 90 \
  --json
```

Exits non-zero and names the failing assertion. Prints, per room, the room uid,
session uid, join code and the full `/client/#config=…` URL — so a human can
open the same rooms in a browser and watch the run they are asserting on.

### Live demo mode

```bash
npm run e2e:demo -- --hold
```

Runs the assertions, then keeps both rooms alive with audio flowing and prints a
**freshly minted join code and viewer URL** each time the previous one expires
— join codes live five minutes. Ctrl-C prints the assertion report and stops the
audio; the rooms are left in place.

The refresh is keyed off each code's own `validEnd`, not a fixed interval, and
that distinction is load-bearing: `admin-fetch-join-code` does not rotate on
demand. It returns the code covering _now_ and mints a new one only once none is
current. Polling it every four minutes reprints the _same_ code with a minute of
life left and then goes quiet for another four — an operator following that
output would be handing out links that die a minute later.

## Options

| Flag               | Default             | Meaning                                                                |
| ------------------ | ------------------- | ---------------------------------------------------------------------- |
| `--base-url`       | `https://localhost` | stack origin (self-signed certs accepted)                              |
| `--rooms`          | `2`                 | how many rooms. A = on-demand, B = AUTO, the rest on-demand            |
| `--stream-seconds` | `90`                | how long to wait for every assertion before declaring failure          |
| `--hold`           | off                 | live-demo mode: never tear down, keep streaming, keep refreshing codes |
| `--keep`           | off                 | run the assertions, then leave the rooms in place                      |
| `--env-file`       | —                   | where to read `SESSION_MANAGER_API_KEY` / `ORIGIN` from                |
| `--json`           | off                 | machine-readable result                                                |

Keys default from `<repo>/deployment/.env`, then `<repo>/../deployment/.env`;
`SESSION_MANAGER_API_KEY` in the process environment wins over both. The viewer
URLs use `ORIGIN` from that file when present, so the printed links are the ones
a browser on another machine can actually open.

## Notes

The non-obvious constraints this tool encodes, each of which cost real time to
find:

- **`test-audio-generator` cannot be pointed at rooms you create.** A device
  token reaches only its own device's room, and the two synthetic devices are
  pinned to `TEST-AUDIO-GOOD` / `TEST-AUDIO-FAULT` by reserved uid, with
  `room-management` refusing to move them. That restriction is the safety
  boundary for synthetic audio, not an oversight — so a demo harness has to
  bring its own source. This one registers a throwaway device per room and
  drives it with `@scribear/test-audio-source`, the same engine the canary and
  those two devices run on.

- **Join codes are minted lazily.** Creating a session does not create a code,
  and the room detail page does not show one — only
  `POST /session-auth/admin-fetch-join-code` (or an operator opening
  `/admin/sessions/:uid`) mints one. This was the missing step in the demo
  runbook: the operator had a live session and no way to get anyone into it.
  Codes live 5 minutes and rotate.

- **The viewer URL is a hash fragment, not a query parameter**, and the
  trailing slash on `/client/` is load-bearing:
  `{origin}/client/#config=<base64(JSON.stringify({clientSessionConfig:{joinCode}}))>`.
  The app consumes the fragment and reloads once.

- **Activation codes are single-use and expire in 5 minutes**, so
  `register-device` and `activate-device` are adjacent calls here with nothing
  between them. `activate-device` is unauthenticated — the activation code is
  the credential — and it reveals the device secret exactly once, in a
  `Set-Cookie` header rather than the response body.

- **An AUTO window needs its `activeStart` backdated by more than "a bit".**
  The materializer drops any occurrence whose _start_ precedes `activeStart`
  (`inRange`, `schedule-materializer.ts`); only surviving occurrences are then
  clipped to `now`. A window created at 16:39 UTC with `activeStart` one hour
  earlier therefore loses today's 00:00 occurrence entirely and materializes
  its first AUTO session **tomorrow**. This tool backdates a week. (Separately,
  the admin console's window dialog forces `activeStart` into the future, so a
  window created through the UI has the same problem for a different reason;
  the API accepts a past start.)

- **One source device per room, one room per device, one active session per
  room** — enforced by DB triggers and an exclusion constraint. Each run
  provisions a fresh device per room and deletes room-then-device on exit
  (the room must go first: a device cannot be deleted while it is its room's
  source).

- **The viewer is a separate socket on the `/client` route.** A source token
  also carries `RECEIVE_TRANSCRIPTIONS`, so it is tempting to read captions
  back on the source socket — but that skips the fan-out path, and a pass would
  then be a claim about a code path no real viewer takes.

### Capacity

`transcription-service` admits sessions against a per-worker estimate
(`capacity_estimator.py`), and `provider_config.json` ships `num_workers: 1`.
The estimate is **not** a fixed number: it starts low on a cold process and
ratchets up as measured per-session cost comes in. It was `2` on this box during
the investigation that prompted this tool, and `52` after a redeploy and warm-up
— so `--rooms 2` is not inherently at the ceiling, and neither is `--rooms 3`.

When admission _is_ refused, the failure is easy to misread as a generic
connection fault: the transcription service closes **1013**, node-server
publishes `sessionStatus` with `transcriptionServiceDisconnectReason:
"at-capacity"`, and the viewer shows another reconnecting-flavoured banner. This
tool watches for both and reports `capacityRefusal` separately from the ordinary
assertions, with the ceiling named. Use `--rooms N` to probe it deliberately;
`/providers/health` (needs `TRANSCRIPTION_METRICS_KEY`) reports the live
`estimatedCapacitySessions`.

### Known limitations

- **`--hold` closes the harness's own viewer sockets** once the assertions have
  passed. Their session tokens expire in 5 minutes and this tool implements no
  refresh; the browser is the viewer for the rest of a held demo. The sources
  _are_ refreshed — the streamer re-authenticates every 4 minutes, at the cost
  of a sub-second gap in audio between segments.
- The assertions stop as soon as every room has satisfied them, which is
  typically 5–10 seconds in, so `framesSent` in the report is a few dozen rather
  than a full `--stream-seconds` worth. `--hold` is the way to keep audio
  running.
- Rooms are only cleaned up by the process that created them. A run killed with
  `SIGKILL` leaves a room and a device behind; they are named
  `demo-<pid>-<epoch>-<label>` so they are easy to find and delete.
