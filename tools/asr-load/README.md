# Transcription-service load driver and CPU benchmark

Streams real speech at the transcription service as SAFP frames, at real time,
from as many concurrent sessions as you ask for, and reports **what the
container spent to serve them**.

```bash
npm run asr:load                                   # 1 session, 60s
npm run asr:load -- --sessions 3 --seconds 90      # concurrency
npm run asr:load -- --provider crisper_whisper     # any provider_config key
npm run asr:load -- --json                         # for CI or a diff
```

Needs a running stack (`deployment/compose.yml`). Nothing else: the API key
comes from `deployment/.env` and the host from `docker inspect`.

## Why not `npm run e2e:audio`

That tool drives a real headless Chromium through the kiosk, which is what you
want for a **correctness** check — it is the only thing that covers the browser's
capture path. It is the wrong instrument for a **cost** question: Chromium,
node-server and the browser's audio stack all land inside the measurement, and
it cannot run two sessions at once.

This one talks to `/transcription_stream/<provider>` directly, so the CPU it
reports is the service's own, and it scales to as many sessions as the box takes.

## What it reports, and what to read

```
transcript messages   : 158
finalized words       : 206
  per 1000 chunks     : 230.2
transcripts/1000 chunk: 176.5
container CPU         : 33.5% mean, 101.18% max (45 samples)
cores per session     : 0.34
```

The pair that matters is **rates against cost**. The rates say the service is
still transcribing as well as it was; `coresPerSession` says what that cost. A
change that moves one without the other is the interesting kind:

| rates | cores/session | reading                                               |
| ----- | ------------- | ----------------------------------------------------- |
| hold  | falls         | waste removed — the fix you wanted                    |
| hold  | holds         | no effect                                             |
| fall  | falls         | you broke transcription and saved CPU by not doing it |
| hold  | rises         | new work; check it is work you meant to add           |

Rates are per 1000 chunks rather than per second so runs of different lengths
and session counts compare directly.

This is what the tool was written for. A single GPU session cost 2.4 cores
because OpenBLAS spun a thread per core (`deployment/UPGRADING.md`), and
throughput, transcripts and latency all looked perfect the whole time — the only
signal was cores-per-session. Two 90s runs of this tool either side of the fix,
895 chunks each:

|        | transcripts/1000 | words/1000 | CPU mean | CPU max | cores/session |
| ------ | ---------------- | ---------- | -------- | ------- | ------------- |
| before | 174.3            | 227.9      | 238.8%   | 513%    | 2.39          |
| after  | 176.5            | 230.2      | 33.5%    | 101%    | 0.34          |

Rates within 1.3%, cost down 7×. That is the shape of a waste finding, and
neither column alone would have shown it.

## Interpreting `max`

Expect `max` to be several times `mean`. Each job period re-transcribes the
whole buffer, so cost tracks buffer length, which VAD and finalization keep
short most of the time and occasionally do not. A `max` near
`100% × sessions × (job period / transcribe time)` means the provider is at the
edge of keeping up; past that it is falling behind and latency grows.

## Options

| Flag          | Default                                        | Meaning                                                |
| ------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `--sessions`  | `1`                                            | concurrent streaming sessions                          |
| `--seconds`   | `60`                                           | how long each one streams                              |
| `--provider`  | `whisper`                                      | key in `provider_config.json`                          |
| `--chunk-ms`  | `100`                                          | frame size; the kiosk's `AUDIO_CHUNK_MS`               |
| `--host`      | container IP                                   | stack host, if not the container itself                |
| `--container` | `deployment-transcription-service-1`           | what to sample and resolve                             |
| `--api-key`   | `TRANSCRIPTION_API_KEY` from `deployment/.env` | service key                                            |
| `--wav`       | `test_audio_files/speech/harvard_16k_mono.wav` | 16kHz mono 16-bit                                      |
| `--no-stats`  | off                                            | skip CPU sampling, and the `docker` dependency with it |
| `--json`      | off                                            | machine-readable result                                |

Exits non-zero if any session errored, closed uncleanly, or received no
transcripts.

## Notes

- **It addresses the container's IP, not `localhost`.** nginx does not proxy
  `/transcription_stream` — it is an internal service — and publishing its port
  would mean editing `compose.yml` to run a benchmark, i.e. changing the thing
  being measured. Docker's bridge network is routable from the host, so this
  needs no change to the stack.
- **Each frame's payload is a self-contained WAV**, not a bare PCM slice: the
  service opens every chunk with soundfile and validates its header. Same as the
  live-stack crosscheck suite.
- **Credentials go out before any audio.** The service closes 1008 on an
  unauthenticated binary frame, so a frame overtaking the handshake would fail
  the run for a reason unrelated to load.
- **The fixture loops.** `harvard_16k_mono.wav` is ~34s, so a longer run repeats
  it. Deterministic, and fine for a cost measurement — but do not read the word
  counts as a transcription-accuracy score.
- **CPU is sampled per second via `docker stats`**, which is the cgroup's own
  accounting for the whole container. For attributing CPU _inside_ the service,
  profile the worker process instead — `py-spy` against the
  `--multiprocessing-fork` PID from `docker top`, from the host, since the
  container carries neither py-spy nor `CAP_SYS_PTRACE`.
