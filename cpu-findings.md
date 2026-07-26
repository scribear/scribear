# Why the Whisper ASR service was burning CPU

Investigation, 2026-07-26. Branch `perf/whisper-cpu` off `staging`
(`20fb727` the fix, `9629022` the benchmark tool).

## Summary

A single streaming session cost **2.4 cores** of CPU — peaking over five — on a
host doing its inference on the GPU. Almost none of that CPU was doing any work.

**Importing `numpy` loads OpenBLAS, which starts one thread per core (19 on this
20-core host) and _spin-waits_ between calls rather than sleeping.** The
streaming provider re-transcribes its whole buffer every `job_period_ms`
(500ms), so the pool never idled long enough to back off, and 19 threads spun
for the life of every session.

Capping the pool cut CPU **7×** with byte-identical transcripts and slightly
_lower_ latency. The naive form of that cap would have made the CPU-device image
**3.4× slower**, which is most of what the fix is about.

## The symptom, and why nothing caught it

At idle the service looked fine: 0.2% CPU, model resident on the GPU (9.5GB
VRAM). Under one streaming session, `docker stats` showed 400–450%, and a 90s
controlled run averaged 239% with peaks over 500%.

Every other signal was healthy. Transcripts arrived at the normal rate, latency
was normal, the GPU was doing the inference it was supposed to, and no error or
counter fired. There is no alert for "this is costing 7× what it should" —
which is why the [benchmark tool](tools/asr-load/README.md) this investigation
produced reports cost per session beside throughput, not pass/fail.

## Method

1. **Reproduce under load.** A WebSocket feeder streaming SAFP frames at real
   time straight at `/transcription_stream/whisper`, bypassing the kiosk and
   node-server so their CPU stayed out of the measurement. This is now
   `npm run asr:load`.
2. **Profile the worker.** `py-spy` from the host (the container has neither
   py-spy nor `CAP_SYS_PTRACE`) against the `--multiprocessing-fork` PID.
3. **Follow the discrepancy.** The Python profile accounted for only a third of
   the wall time and none of the parallelism — so the burn was in native threads
   the Python view cannot see. `top -b -H` on the worker named them.
4. **A/B in isolation.** An in-container probe that counts threads after each
   import and measures CPU per `transcribe` call, swept across thread settings
   and both devices.

## What the profile showed

The Python-visible profile was the first real clue precisely because it looked
*innocent*. Over 25s of sampling at 200Hz, the worker spent 8.75s inside
`_execute_job` — a 35% duty cycle — and its self-time was almost entirely
`threading.wait` and `selectors.select`. Nothing in Python was busy. Yet the
container was pinning four and a half cores.

`top -b -H` on the worker process resolved it: **18 anonymous threads, each
burning 8–15% CPU**, with contiguous TIDs allocated at process start.

The in-container probe attributed them precisely — the count jumps on the
`import numpy` line, before any model exists:

| after | threads |
| --- | --- |
| `import numpy` | 20 |
| `import torch` | 20 |
| `torch.set_num_threads(1)` | 20 |
| `WhisperModel(turbo, cuda)` | 25 |
| first `transcribe` | 26 |

With `OPENBLAS_NUM_THREADS=1` **or** `OMP_NUM_THREADS=1`, that first row is 1
instead of 20 — this OpenBLAS build (scipy-openblas 0.3.30) is OpenMP-backed, so
either variable governs it.

The mechanism is spin-waiting, not work: OpenBLAS's threads busy-wait after a
parallel region in case another arrives. Whisper touches BLAS constantly on a
500ms cadence, so the pool never reached the point of sleeping.

## Evidence

One 30s buffer per `transcribe` call, whisper `turbo`, word timestamps on, RTX
5070 Ti, 20-core host. **Every row produced identical transcripts.**

### CUDA device

| config | wall/call | CPU/call | cores |
| --- | --- | --- | --- |
| as shipped | 0.752s | 3.450s | **4.59** |
| `OMP=1` | 0.675s | 0.670s | **0.99** |
| `OMP=1 OPENBLAS=1` | 0.720s | 0.720s | 1.00 |
| `OMP=2 OPENBLAS=1` | 0.680s | 0.840s | 1.23 |
| `OMP=4 OPENBLAS=1` | 0.742s | 1.210s | 1.63 |

Capping is not a latency trade: wall time improved. The pool was pure
contention, and adding threads back only costs CPU.

### CPU device — where the naive fix breaks

| config | wall/call | CPU/call | cores |
| --- | --- | --- | --- |
| as shipped | 17.971s | 71.960s | 4.00 |
| `OMP=1 OPENBLAS=1` | **61.790s** | 61.760s | 1.00 |
| `OMP=1 OPENBLAS=1` + `cpu_threads=8` | 14.358s | 105.280s | 7.33 |
| `OMP=1 OPENBLAS=1` + `cpu_threads=4` | 19.326s | 74.070s | 3.83 |

Row 2 is the trap: faster-whisper's default thread count *reads
`OMP_NUM_THREADS`*, so the environment cap would have serialised CPU inference —
**3.4× slower**. Row 4 shows the way out: CTranslate2 applies its own
`cpu_threads` via `omp_set_num_threads`, which overrides the environment for its
own compute. Parity with the shipped image, minus 19 spinning threads.

### End to end on the live stack

`npm run asr:load --sessions 1 --seconds 90`, 895 chunks each side, same
instrument:

| | transcripts/1000 chunks | words/1000 chunks | CPU mean | CPU max | cores/session |
| --- | --- | --- | --- | --- | --- |
| before | 174.3 | 227.9 | 238.8% | 513% | **2.39** |
| after | 176.5 | 230.2 | 33.5% | 101% | **0.34** |

Rates within 1.3%; cost down 7×. Concurrency scales cleanly now: 2 sessions cost
0.26 cores each, 3 sessions fit inside a single core and all three transcribed
identically (~206 words each, no errors).

After the fix, `top -H` shows one worker thread doing work at ~17%; the rest of
the process is idle HuggingFace and CUDA event threads.

## The fix

`20fb727`, three files:

- **`Dockerfile_CUDA`, `Dockerfile_CPU`** — `OMP_NUM_THREADS=1` and
  `OPENBLAS_NUM_THREADS=1`. This is where it belongs rather than in code:
  OpenBLAS reads the variable when the library loads, i.e. on `import numpy`, so
  setting it in Python means racing the first import in the process — reliable
  only until someone reorders an import, and `isort` will.
- **`faster_whisper_context.py`** — `cpu_threads` is now chosen explicitly and
  configurable per context: `DEFAULT_CPU_THREADS = 4` on the cpu device
  (CTranslate2's own default, measured at parity), `1` on cuda. This is what
  makes the environment cap and CPU throughput independent.

Deliberately **not** `os.cpu_count()` for the CPU default: with `num_workers`
> 1 each worker would claim every core.

The regression this guards against is silent — transcripts stay identical and
only throughput collapses — so the device-aware defaults are asserted in a unit
test (`tests/unit/transcription_contexts/`) rather than left to a comment.

Operator-facing notes are in `deployment/UPGRADING.md`, including the warning
that raising `OMP_NUM_THREADS` in your own compose is a pessimisation rather than
a tuning knob.

## Validated

- Rebuilt `scribear/transcription-service-{cuda128,cpu}:dev` and measured the
  real committed image, not just an environment override. The service logs the
  `cpu_threads` it chose (`1` for both cuda contexts).
- 472 unit tests pass, 6 new. `pylint` 10.00/10, `isort`/`black` clean, the tool
  prettier-clean.
- Before/after through one instrument at the same settings (table above).

## Ruled out

- **Silero VAD** — already single-threaded (`torch.set_num_threads(1)`), already
  incremental (3.5ms per job period against 69.7ms for a full rescan), and
  correctly on the CPU, where it is faster than CUDA for a 512-sample streaming
  model.
- **CTranslate2's `cpu_threads` alone** — setting it to 1 without the
  environment cap left CPU at 3.99 cores. It was never the source.
- **The GPU** — inference genuinely runs there; VRAM resident, and CUDA-side
  work was never the cost.

## Still open: the job period is oversubscribed at a full buffer

Not touched, and worth its own decision. `job_period_ms: 500` with
`max_buffer_len_sec: 30` means the provider aims to re-transcribe up to 30s of
audio every 500ms. On this GPU a full 30s buffer takes **~680ms** to transcribe
— so whenever the buffer fills, the provider cannot keep up by construction, and
each period falls further behind.

It works in practice because VAD gating and finalization usually keep the buffer
far shorter than 30s. But the headroom is not there at the limit, and this is
now the dominant cost: re-transcribing the same audio every period is O(buffer)
work per period. The CPU fix removed the waste *around* the inference; this is
about the amount of inference asked for.

Options, costs and a recommendation are in
`~/scribear2/NEXTSTEPS-CPU-Whisper.md`.
