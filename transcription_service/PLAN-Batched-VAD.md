# PLAN: Batched-window VAD

Status: **proposal, not scheduled.** Nothing here is implemented. This document
exists so the idea is evaluated on evidence rather than on the intuition that a
GPU must be faster.

Read `src/shared/utils/silence_filter/incremental_vad.py` first — its module
docstring holds the measurements this plan builds on.

## The bar to beat

VAD cost per job period, 30s buffer, 500ms period, real model, single CPU
thread (`scripts/vad_bench.py`, 100s session):

| Implementation | Median per call |
|---|---|
| Full-buffer rescan (before) | 69.7 ms |
| **Incremental, shipped** | **3.5 ms** |

Of that 3.5 ms, roughly **1.2 ms is model scoring and 2.3 ms is segmentation** —
Silero's `get_speech_timestamps` walking every cached window in Python on every
call.

This matters more than it looks. A batched-window redesign targets the scoring
only. Even if scoring went to **zero**, the call would still cost ~2.3 ms, so
the ceiling for this whole project is about **1.5×** end to end, not the 124×
the raw kernel numbers suggest. Amdahl's law applies before any GPU does.

**Do the cheaper thing first.** Making the *segmentation* incremental — keeping
the hysteresis state machine's position across calls instead of replaying it —
attacks the 2.3 ms, needs no GPU, no accuracy tradeoff, and no new hardware
dependency in the deployment. If someone has appetite for VAD performance work,
that is where it should go. It is not done yet because it means owning Silero's
segmentation rules (threshold hysteresis, `min_speech_duration_ms`,
`min_silence_duration_ms`, `speech_pad_ms`, the max-speech split) rather than
calling them, and that is a correctness liability the 20× win did not require.

## The idea

Silero scores 512 samples at a time and carries an LSTM state between windows.
Today those steps are issued one at a time. The model does accept a batch
dimension, `(B, 512)`, and on a GPU that is dramatically faster:

| Approach, 30s buffer (937 windows) | Latency |
|---|---|
| Sequential CPU | 74.5 ms |
| Sequential CUDA | 128.1 ms |
| Batched CUDA, 64 rows | 2.8 ms |
| Batched CUDA, all 937 | 0.6 ms |
| Batched CPU, all 937 | 16.8 ms |

Note the third row: **batching helps on CPU too** (74.5 → 16.8 ms). If this
plan is pursued, the CPU variant should be measured first — it captures a large
share of the win with no GPU in the deployment at all.

## Why it is not a free win

Batching windows within one stream **breaks the recurrence**. Each row must be
given a state, and the state that belongs to window *i* is produced by window
*i−1*, which is in the same batch. Feeding every row a zero state and comparing
to the sequential baseline over the same audio:

- mean |Δ probability| = **0.40**
- **42%** of window decisions flip at threshold 0.5
- speech windows detected: 576 sequential vs 181 batched

That is not a faster VAD, it is a different and much worse one. Any viable
design has to buy the state back.

## Proposed design: warm-up context

Give each row a short prefix of the windows that precede it, so the LSTM state
is approximately reconstructed before the window being scored.

For warm-up depth *k*, row *i* holds windows `[i-k, i]`, run as a batched
sequence of `k+1` steps: `k+1` batched forwards over `B` rows instead of one,
where every row is at a different absolute position. Cost scales with *k*;
accuracy should approach sequential as *k* grows, because the LSTM's dependence
on distant history decays.

Rough budget: at `k=8`, ~9 batched calls of 937 rows ≈ 5 ms on the GPU measured
above — still well under the 74.5 ms rescan, but **above** the 1.2 ms the
shipped implementation already spends on scoring. **This is the crux: warm-up
context may well cost more than the incremental implementation it would
replace, while being less exact.** The first experiment below is designed to
kill the idea quickly if so.

### Alternative: cross-session batching (exact, no approximation)

Batch one window step across *N different sessions*. Each row is an independent
stream with its own state, so the recurrence is preserved exactly — no accuracy
question at all. Measured GPU step cost is nearly flat in N:

| Streams | 1 | 4 | 16 | 64 | 256 |
|---|---|---|---|---|---|
| CUDA ms/step | 0.17 | 0.17 | 0.17 | 0.18 | 0.21 |
| CUDA µs/stream-step | 170 | 42.8 | 10.6 | 2.8 | 0.8 |
| CPU µs/stream-step | 82.6 | 70.5 | 30.1 | 18.8 | 16.0 |

GPU overtakes CPU at ~4 concurrent sessions. The cost is architectural rather
than numerical: a shared VAD service that coalesces per-window requests across
jobs, holds per-session state, and bounds the added latency of waiting for a
batch to fill. Worker processes today are single-threaded and own their
contexts, so this crosses a process boundary that nothing else in the
transcription path crosses.

**If GPU VAD is ever pursued, prefer this over warm-up context.** It has no
accuracy gate to pass, because it changes nothing about how a window is scored.

## Experiments, in order

Each stage is cheap and answers a kill question. Stop at the first "no".

**E1 — Does warm-up context recover accuracy at all?** (offline, hours)
Sweep `k ∈ {0, 2, 4, 8, 16, 32}` over ≥30 min of varied speech. For each,
compute per-window probability error and decision-flip rate against the
sequential baseline. *Kill if* no *k* under the latency budget gets the flip
rate under the E2 gate.

**E2 — Does it change what listeners see?** (offline, days)
For the surviving *k*, compare speech *ranges* (not probabilities) and then WER
of the resulting transcripts against the sequential baseline on the same audio.
Ranges are what feeds Whisper; probability error is only a proxy.

**E3 — Is it actually faster in situ?** (a day)
Wire the winner behind a config flag and measure end-to-end job-period cost
with `scripts/vad_bench.py`, including host↔device transfer, which the 0.6 ms
figure excludes (~1.9 MB per 30s buffer). *Kill if* the median per-call time is
not below 3.5 ms, which is what it must beat to be worth any of this.

**E4 — Does it survive the deployment?** (a day)
GPU VAD makes the CPU image and the CUDA image behave differently, so both need
coverage. Also confirms the `silence_filter.py` device-transfer bug is fixed
(see below), since nothing exercises a GPU-resident model today.

## Gates

A batched implementation ships only if **all** of these hold. They are
deliberately strict: the thing being replaced is already fast, so the only
reason to take on approximation is a large, proven win.

1. **Decision-flip rate < 1%** of windows against the sequential baseline, over
   the full evaluation corpus (E1). For reference, naive batching is 42%.
2. **Speech-range edges within 50 ms** at the 95th percentile, and **identical
   segment counts in ≥99%** of periods (E2). Calibration: the incremental
   change that shipped moves edges by a median of 12 ms, max 220 ms, with 9 of
   142 divergent periods differing in segment count.
3. **No WER regression** beyond noise on the evaluation set (E2). A VAD that
   trims a leading consonant is cheap to measure here and expensive to discover
   in a lecture hall.
4. **Median per-call cost < 3.5 ms** including transfer, measured in the job
   loop, not in a microbenchmark (E3). A win under 2× is not worth the
   complexity.
5. **CPU parity path.** The CPU-batched variant (16.8 ms) must be measured and
   reported alongside. If it passes gates 1–3 and gets most of the win, ship
   that instead: it needs no GPU in the deployment.
6. **Graceful degradation.** Falls back to the incremental path on any failure,
   with the fallback logged at warning. VAD failures currently degrade to "no
   speech", which silently produces empty transcripts — see below.

## Tests required

Unit (fake model, no weights downloaded — matching
`tests/unit/shared/utils/silence_filter/incremental_vad_test.py`):

- Batch assembly: row *i* contains windows `[i-k, i]`; correct handling at the
  start of a stream where fewer than *k* predecessors exist.
- Batch boundaries: a buffer whose window count is not a multiple of *B*.
- The invariant that already has coverage and must not regress: each window's
  audio is scored once, cached, aligned by absolute stream position, and
  correctly re-indexed after an unaligned purge.
- Failure path: a raising model yields no ranges rather than an exception, and
  a failed batch falls back rather than dropping the period.

Equivalence (real model, `scripts/vad_bench.py`):

- Extend the harness with `--impl` so baseline / incremental / batched are
  compared in the same terms it already reports: identical-over-scored-region
  counts, segment-count mismatches, and edge-movement distribution.
- Run at both shipped provider configs (`job_period_ms` 500 and 5000,
  `max_buffer_len_sec` 30) — batch sizes differ by an order of magnitude
  between them, and the 5000 ms config is where a large batch is plausible.

Integration:

- The existing integration suite deliberately avoids loading real models. Keep
  it that way; the real-model comparison belongs in the harness, run by hand or
  in a nightly job, not in PR CI.

## Prerequisite, independent of this plan

`silence_filter.py` builds its input tensor on the CPU and hands it to a model
that `SileroVadContext` may have moved to the GPU. The result is a TorchScript
device-mismatch error, which the handler converts to "no speech", so a
deployment that sets `"device": "cuda"` starts cleanly, reports healthy, and
emits no captions, logging only at debug level.

Any GPU work must fix this first. It is a one-line device transfer. Two
independent decisions are worth making regardless of whether this plan proceeds:

- Reject `device != "cpu"` at context creation, so the broken option fails loudly
  instead of silently, until something actually supports it.
- Raise the swallowed-VAD-failure log above debug. This bug is one way to reach
  "VAD returned nothing"; a warning would have surfaced it immediately.
