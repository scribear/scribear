# End-to-end audio check

Drives a real headless Chromium kiosk against a running stack and verifies that
audio reaches a transcription provider — and, optionally, that it **keeps**
reaching one after the transcription service restarts underneath it.

Unlike `tools/a11y`, this needs the whole stack up (`deployment/compose.yml`):
session-manager, node-server, and transcription-service all take part.

## Why

`apps/kiosk-webapp` has no test suite, so the audio capture path was only ever
exercised by hand. The failure this was written for was invisible to every other
check: the kiosk stayed connected, node-server kept accepting frames, the admin
console kept reporting the session as live — and audio silently stopped reaching
a provider after the first upstream blip, because credentials were sent once per
_session_ instead of once per _connection_. Catching that needs a real browser
and a deliberately broken upstream.

## Run

```bash
# One-shot: does audio flow at all?
node tools/e2e-audio/kiosk-audio-e2e.mjs --activation-code ABCD1234

# The regression check: break the upstream mid-stream, require recovery.
node tools/e2e-audio/kiosk-audio-e2e.mjs \
  --activation-code ABCD1234 \
  --stream-seconds 120 \
  --restart-cmd 'docker compose -f deployment/compose.yml restart transcription-service'
```

Exits non-zero on failure and prints which assertion failed. `--json` emits the
result as JSON for CI.

## Setup

The device must be registered and its room must have an active session:

```bash
cd deployment
./register-device.sh kiosk-e2e            # -> deviceUid + activationCode
./create-room.sh e2e-room <deviceUid>     # -> roomUid
./create-session.sh <roomUid> e2e-session # on-demand, starts immediately
```

Activation codes are **single-use**: each run needs a fresh one, or a device
that is already activated in a profile you keep.

## Options

| Flag                | Default             | Meaning                                           |
| ------------------- | ------------------- | ------------------------------------------------- |
| `--base-url`        | `https://localhost` | stack origin (self-signed certs are accepted)     |
| `--activation-code` | —                   | required unless the profile is already registered |
| `--stream-seconds`  | `45`                | total streaming time; the restart happens halfway |
| `--restart-cmd`     | —                   | shell command to restart the upstream mid-stream  |
| `--json`            | off                 | machine-readable result                           |

Chrome is auto-detected from `CHROME_PATH`, then `/usr/bin/google-chrome-stable`,
`google-chrome`, `chromium-browser`, `chromium`.

## Notes

- Audio comes from Chrome's fake capture device fed by
  `test_audio_files/speech/harvard_16k_mono.wav`, so runs are deterministic and
  need no real microphone.
- The microphone permission is pre-granted. Without that the kiosk stops at
  `INFO_PROMPT` and waits for a second activation call, which looks exactly like
  a genuine audio fault — connected, but silent.
- The mic control is a toggle, so the script clicks and then _verifies_ binary
  frames are on the wire rather than clicking a fixed number of times.
