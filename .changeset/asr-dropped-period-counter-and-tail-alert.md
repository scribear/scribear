---
'@scribear/monitoring-sidecar': minor
---

Count dropped job periods exactly, and alert on the overrun tail between the two
existing T1 rules (§3 T1).

**The failure, restated.** The whisper-streaming provider re-transcribes its
unfinalized buffer every `job_period_ms`. When a pass overruns, `worker_process.py`
advances the job's `period_start_ns` by whole periods until it passes now, so the
missed periods are **dropped, never queued**. No exception, no backlog, no log
line: the effective period silently becomes a multiple of the configured one while
captions get staler and every counter, probe and health check stays green. Measured
on an RTX 5070 Ti with whisper `turbo`, a full 30 s buffer costs ~680 ms against the
CUDA config's 500 ms period — 1.36x budget, invisible everywhere.

**The counter, and the wrong version of it.** The obvious build was a counter of
observations where `asr_rtf >= 1.0`. That inherits the exact blind spot it was
meant to close, and a live measurement proves it: RTF's denominator is the audio
*that pass* ingested, and a dropped period leaves more audio for the next pass, so
RTF **falls** as periods are lost. At 1/2/3/5/8 concurrent sessions sharing one
worker, mean RTF went 0.277 → 0.256 → 0.229 → 0.194 → 0.139 while the worker went
26% → 94.5% busy and transcripts per 1000 chunks collapsed 190 → 48. At eight
sessions periods were certainly being dropped and RTF read 0.139.

So transcription-service now counts the real thing, in the only place that can see
it. The `while` loop that advances `period_start_ns` runs once for the ordinary
advance to the next period; every *additional* iteration is a period the job will
never run in. `iterations - 1` is therefore the exact number of dropped periods, and
it is reported as `asrDroppedPeriodsTotal` per provider on `GET /metrics/status`,
exported by the sidecar as `scribear_asr_dropped_periods_total`.

**Where it rides out, and why there.** The count is scheduler state, so it is held
on the pool's own `_JobEntry` and written into the `counters` dict that
`JobSuccess`/`JobException` already carry — *not* into the job's
`JobCounterCollector`. A job is never told a period was skipped, cannot observe one,
and must not be able to fabricate or suppress the count by overriding
`drain_counters`; the pool-owned name (`worker_pool.DROPPED_PERIODS_COUNTER`) wins
over a job that reuses it. Reusing the existing dict rather than adding a result
type is deliberate: the parent already labels a `JobExecutionResult` with its
provider and folds its counters into per-provider totals, so a dedicated
scheduler-counter message would need its own label lookup and its own observer to
say the same thing. The cost is one execution of lag — the count is only known after
the segment loop, and results are queued per segment so transcripts reach clients
immediately, so buffering them to attach an exact count would delay live captions to
improve a metric. Monotonic totals make a one-period shift invisible in any windowed
rate.

Worth having for a single session, not only under concurrency: a lone stream whose
buffer grows past what the GPU can do in one period drops periods with a perfectly
healthy-looking RTF.

**The tail alert.** `transcriptionTailOverrunRule` (WARNING, T1) covers the band
between the two rules that already exist — `transcriptionSaturationRule` (CRITICAL,
p95 RTF ≥ 1.0) and `transcriptionFallingBehindRule` (WARNING, mean RTF ≥ 0.45). That
band is normal shape rather than a corner case: per-pass cost tracks the length of
the unfinalized buffer, so a healthy provider's distribution is wide by
construction. Measured sub-job spread on one session was p50 0.235 / p95 0.653 / max
0.840, which is a provider that can sit at a 0.24 median and still overrun every
time its buffer gets long.

It fires on the share of *scheduled* periods that were dropped —
`drops / (drops + passes)` over `rateWindowMs` — rather than a raw rate, so one
threshold holds across every `job_period_ms` and so the first poll after a sidecar
restart (which folds a service's whole lifetime total as a single delta) reads as a
lifetime average rather than as a window's worth of drops.

- **Threshold `ALERT_ASR_DROPPED_PERIOD_RATIO`, default 0.01 — reasoned, not
  measured**, unlike the 0.45 beside it, which came from a 42-minute live capture.
  No capture of a provider that is dropping periods exists yet. 1% is what the
  fallback path below implies, so the alert means roughly the same thing whichever
  signal produced it, which matters because it can switch signals mid-incident. A
  dropped period is a lost caption update rather than a tolerance, so a healthy
  deployment should read zero.
- **Fallback: `asrRtf{quantile=p99} >= 1.0`** when the counter is absent. Not
  hypothetical — during a rolling upgrade the sidecar polls a transcription-service
  that predates it, and the p99 gauge has been on the wire since B1.2. Same
  prefer-reported-then-fall-back shape the per-provider job-period work established
  in this file. It is strictly worse (a fixed 1% grid, no distance past the line, and
  computed over the far end's ring rather than `rateWindowMs`) which is why it is
  second, and the alert text says which signal fired.
- **`scribear_asr_dropped_periods_supported`** exists because "no series" is
  ambiguous in the other direction: a healthy new service sends an empty array and a
  counter that never increments creates no series either, so absence would mean
  *either* "nothing dropped" or "nothing counting" — and those demand opposite
  responses. Published rather than guessed, and independently the honest answer to
  "why did this alert change shape mid-upgrade".
- **No double-reporting.** Silent while `asrRtf{p95} >= ALERT_RTF_P95`: percentiles
  are monotone, so p95 ≥ 1.0 implies p99 ≥ 1.0 and the fallback path would always
  co-fire, and on the counter path a p95 at realtime means ≥5% of passes overrun,
  which is the outage the CRITICAL owns. Also silent while the **mean** rule is over
  its threshold — a judgement, not an implication: both are WARNING, same provider,
  same stage, same three levers, so a second card adds prose and no decision. This
  rule owns exactly the band the mean rule does not. The two hand off in the right
  direction, because severe dropping *lowers* mean RTF: a provider that falls out of
  the mean rule's band lands in this one rather than in silence.
- **Floored on samples, `ALERT_ASR_TAIL_MIN_JOBS` default 100**, five times the mean
  rule's floor, for two reasons that land on one number. A reported p99 is only a
  percentile given samples: at 100 it is the second-worst pass, at 24 (a 120 s window
  at lumen_granite's 3000 ms period) it *is* the worst pass, and a rule on that flaps
  on one slow inference. And 100 is what stops a 1% share firing on a single dropped
  period. The cost is explicit: a provider whose period is long enough that
  `ALERT_RATE_WINDOW_SEC` holds fewer passes than this gets no tail alert at all — at
  the default window, anything above ~1.2 s, lumen_granite included. Widen the window
  for such a deployment rather than lowering the floor.
- **The levers are not the CRITICAL's.** One stream is one job and its passes run one
  at a time, so neither workers nor CPU shortens a pass already alone on the GPU.
  `max_buffer_len_sec` (cost tracks buffer length, and this rule fires on the
  long-buffer tail specifically), `job_period_ms`, and model size are what move the
  number.

**`providerJobPeriodMs` is now populated**, which closes the duplication the previous
changeset left open. `GET /metrics/status` reports the period each provider schedules
with, taken from the provider itself via a new
`TranscriptionProviderInterface.job_period_ms` (concrete, defaulting to `None`, so a
provider added later cannot fail to construct over a telemetry question) rather than
from a `getattr` on provider config — which would be wrong for `debug`, whose period
is a literal, now the single `DEBUG_JOB_PERIOD_MS` constant that `register_job` also
reads. A provider with no period to state is **omitted** from the map rather than
given a placeholder, so the poller's "no period known, publish nothing" path still
means what it says. The sidecar already preferred a reported period, so
`TRANSCRIPTION_JOB_PERIOD_MS` becomes a fallback for a service too old to send one;
`scribear_asr_job_period_ms{source=reported|configured}` shows which is in use, and
`deployment/compose.yml`'s bare `${MONITORING_JOB_PERIOD_MS:-1000}` stops mattering
for any provider the service names.

Both new fields on the metrics body are **optional**, unlike everything else in that
schema, for the reason the strictness rule already allows: it is precisely the
mixed-version poll that omits them, and turning that into a `malformed` response
would take every transcription metric down to enforce fields with working fallbacks.
