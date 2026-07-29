# Final summary — whisper CPU investigation and what it turned into

2026-07-26. Branch `perf/whisper-cpu` → **PR #169**, 15 commits, verified against a
live rebuilt stack. Wiki updated and published. `explore/apple-silicon` pushed
separately as findings only, no PR.

Detail lives in `cpu-findings.md` (the investigation),
`~/scribear2/archived-plans/2026-07-26-02-LESSONSLEARNED-CPU-Whisper.md`
(surprises and out-of-scope findings), and
`~/scribear2/archived-plans/2026-07-26-02-NEXTSTEPS-CPU-Whisper.md` (what is
left, with the open decisions).

---

## The original question

**Why is CPU usage high in the whisper ASR service?**

A single streaming session cost **2.4 cores** on a host doing its inference on the
GPU. Almost none of it was work: importing `numpy` loads OpenBLAS, which starts one
thread per core (19 on a 20-core host) and *spin-waits* between calls. The streaming
provider re-transcribes its buffer every 500ms, so the pool never idled long enough
to back off and 19 threads spun for the life of every session.

**Fixed. 7× less CPU at unchanged transcript rates** (238.8% → 33.5% mean, 895 chunks
each side, one instrument). Isolated to a single 30s-buffer transcribe: 4.59 cores →
0.99, with latency slightly *better* — the pool was pure contention.

The trap: capping `OMP_NUM_THREADS` alone makes the **CPU image 3.4× slower**, because
faster-whisper's default thread count reads the same variable. So the environment
bounds incidental pools and `cpu_threads`, chosen per device, restores CTranslate2's
own. That regression is silent — transcripts stay byte-identical and only throughput
collapses — so it is asserted in tests rather than left to a comment.

## What that uncovered

The instrument built to measure the fix (`npm run asr:load`) kept finding things.

**A stuck CRITICAL.** Histogram samples expired by count (4096) and never by age, so
one heavy session left a p95-derived CRITICAL firing at zero load until the process
restarted. Confirmed by accident mid-measurement: the reported `max` stayed pinned at
`10.031` — a job predating the capture — through 50 minutes of load. Now expires on a
120s window matching the alert, with `sum`/`count` deliberately left lifetime because
a rule differences them.

**A metric with the wrong slope.** `asr_rtf` is the obvious "is transcription keeping
up" signal, and under concurrency saturation it **falls as the service degrades**:
0.277 → 0.139 across 1→8 sessions while the worker went 26% → 94.5% busy and
transcripts per 1000 chunks collapsed 190 → 48. An alert on it was not merely silent
at 8 sessions, it was moving *further* from firing. This is why the new counter counts
dropped periods in the scheduler rather than RTF over 1.0 — the obvious
implementation inherits the same blind spot.

**Three alert thresholds that fire on a healthy stack**, all caught by live
verification, all shipped with reasoning that sounded right:

| Threshold | Was | Now | Healthy measured |
| --- | --- | --- | --- |
| `asrDutyRatio` | 0.8 | **0.45** | 0.28–0.33, worst window 0.355 |
| `asrDroppedPeriodRatio` | 0.01 | **0.25** | **11.3%** (dropping periods is normal) |
| `asrTailP99Rtf` | 1.0 | **3.0** | p99 2.17 |
| `rtfP95` (pre-existing) | 1.0 | **2.0** | p95 0.96–1.28 |

A healthy stack now reports `{"alerts":[]}`.

**Two security bugs.** `/status` answered **200 through the public origin** despite its
own schema saying it "must not be exposed through the public reverse proxy"; so did
session-manager's `session-config-stream`. Both now 404, guarded by tests that derive
the path from the route definition. And a *correct* service key could fail with **400**
instead of authenticating, because a `^Bearer [A-Za-z0-9_-]+$` pattern ran before the
auth hook and rejected base64 padding — verified live, now 401 for every credential
problem.

**A latent bug that blocked CPU-only and Apple Silicon hosts entirely.** `compose.yml`
reserved `driver: nvidia` unconditionally, with no reference to `TRANSCRIPTION_DEVICE`
— whose default is `cpu`. The documented default configuration demanded a GPU, and a
host without the NVIDIA runtime could not start the stack at all. GPU access is now
opt-in via `compose.gpu.yml`; a CPU-only host needs nothing.

**Duplicated facts that had gone stale.** A context tagged `whisper_cpu_context` while
its config said `device: cuda`. `job_period_ms` stated in three places, the sidecar's
copy defaulting to 1000 against a shipped 500/500/3000 — silently misscaling every
provider but `debug`. The service now reports its own periods.

## What was measured, not assumed

Every performance number above came from a run. The measurement work was the point,
and three of its results contradicted a plausible belief:

- **Wall time reports a spinning thread pool as free.** The uncapped and capped
  configurations differ by 0.08s of wall time per call and 2.8 seconds of CPU. Read
  `/proc/self/stat`, which counts every thread.
- **A healthy session drops 11% of its periods.** Dropping periods is how the provider
  absorbs the long-buffer tail, not a fault. The 1% threshold that "obviously" follows
  from "a dropped period is a lost caption" would have fired continuously.
- **`p95 RTF ≥ 1.0` is not a fault.** Passes exceeding realtime are routine, because
  cost tracks the unfinalized buffer.

And one number I got wrong: an early "17×" compared pre-fix *peaks* to post-fix
*means*. Corrected to 7× in the same commit series that introduced it.

## Delivered

**Code.** The CPU fix; `cpu_threads` per device; histogram age-expiry; per-provider job
periods reported by the service; an exact dropped-period counter; three calibrated
transcription alerts with suppression between them; the two security fixes; GPU
opt-in; the tag rename.

**Tooling.** `tools/asr-load` — `npm run asr:load`, streams SAFP frames straight at
the service and reports **cores-per-session beside transcripts-per-1000-chunks**,
because that pairing is what the original bug needed: throughput, latency, counters
and health all looked perfect while 2.4 cores burned.

**Docs.** `cpu-findings.md`; `deployment/UPGRADING.md` for operators; and on the wiki,
new **Tools and Benchmarking**, **Node Server Status and Counters** and
**Transcription on CPU-Only Hardware** pages, plus corrections to five existing pages
— including a "still open" validation gap that had in fact been closed, and comments
describing a safety net that had been removed.

## Open decisions for a human

1. **The exposed probe endpoints** — unauthenticated, public, and the readiness body
   leaks database check state, while the authenticated rollup is guarded for exactly
   that reason. Arguable as intended; the question is whether the body should be that
   specific.
2. **Re-key the saturation CRITICAL onto the drop share.** `rtfP95: 2.0` is a stopgap
   on a signal that is wrong in kind; the drop share measures the real thing and has
   the right slope.
3. **One global threshold cannot serve GPU and CPU** — 0.45 is right for CUDA and
   trips on the shipped CPU template, which measured 0.471 while keeping up.
4. **The full-buffer design** — `max_buffer_len_sec` is both "work per period" and
   "when to give up and commit", which is why the only lever also changes caption
   behaviour.

## Verified, and the limits of that

Rebuilt every image and brought the whole stack up on them. Confirmed live: `/status`
404 while public routes answer 200, a base64-shaped key returns 401, `cpu_threads: 1`
on both cuda contexts, `providerJobPeriodMs` reporting all four providers correctly,
`scribear_asr_job_period_ms{source="reported"}`, `asr_dropped_periods_total` reaching
Prometheus, GPU still in use (9.6 GB VRAM, `/dev/nvidia*` mapped) through the new
overlay, transcripts flowing at 0.33 cores/session, and no alerts firing.

Not verified: **the full stack was never run with `TRANSCRIPTION_DEVICE=cpu`** — CPU
numbers come from a standalone probe container beside the live GPU stack, which is
sound for cost but is not the compose path. Nothing ran on actual macOS. And the
CPU-side thresholds have no baseline of their own.
