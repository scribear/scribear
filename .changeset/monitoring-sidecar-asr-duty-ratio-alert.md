---
'@scribear/monitoring-sidecar': minor
---

Alert on transcription quietly losing its period budget, before captions are
visibly late (§3 T1, early warning).

The whisper-streaming provider re-transcribes its unfinalized buffer every
`job_period_ms`. When a pass takes longer than that period, nothing errors and
nothing queues: `worker_process.py` advances the job's `period_start_ns` by whole
periods until it passes now, so the missed periods are **dropped** and the
effective period silently becomes a multiple of the configured one. Captions get
staler while transcript counts, health checks and every error counter stay clean.
Measured on an RTX 5070 Ti with whisper `turbo`, a full 30 s buffer costs ~680 ms
against the CUDA config's 500 ms period — 1.36x budget, invisible everywhere.

`transcriptionFallingBehindRule` warns when the **mean** RTF over the alert window
reaches `ALERT_ASR_DUTY_RATIO` (0.8 by default), per provider. Because each period
ingests roughly one period of live audio, RTF is the duty ratio: 0.8 means four
fifths of the budget is gone. `transcriptionSaturationRule` still owns the 1.0
line as a critical, so this rule does not escalate — the point is to fire while
captions are still on time, and to name the levers that actually move the number
(`job_period_ms`, `max_buffer_len_sec`, model size — not more workers or CPU,
since a stream's passes run one at a time).

A mean and not the p95 the reported percentiles already offer, for two reasons.
Per-pass cost tracks the length of the unfinalized buffer, which grows between
finalizations, so in healthy operation the worst few percent of passes sit well
above the typical one and a p95 pinned at 0.8 would fire on a provider whose real
duty cycle is 0.3. And a reported percentile cannot be re-windowed: it is computed
over transcription-service's own 4096-sample ring, which never expires by time, so
it keeps reporting the same figure after the session that produced it has ended.
The sidecar therefore differences the RTF histogram's lifetime `sum` and `count`
into two new counters, `scribear_asr_duty_ratio_sum_total` and
`scribear_asr_duty_ratio_jobs_total` — both already on the wire since B1.2 and
consumed by nothing until now. Averaging over the rate window makes "sustained"
structural: no single spiky period can move it, and an idle provider contributes
nothing at all rather than a stale high-water mark.

`buffer_overflow_seconds` stays out of the firing condition — it is a consequence,
it has its own T2 rule, and VAD gating usually keeps the buffer short of the cap,
so requiring it would blind the rule to the common case. It is reported in the
alert message when non-zero, because it tells the operator whether audio is
already being discarded.

The threshold default is **0.45**, measured rather than guessed. 42 minutes of
`npm run asr:load` against a live RTX 5070 Ti stack (whisper `turbo`, 500ms period,
30s buffer, `num_workers: 1`) put healthy single-session operation at 0.28 on a
speech-sparse fixture and 0.33 on a speech-dense one, with the worst of 388 rolling
120s windows at 0.355 — so 0.45 clears measured-healthy by 27% and fired zero false
alarms. The first draft used 0.8, which the same capture showed is not an early
warning at all: it needs a 2.9x per-pass regression to trip, by which point the
provider is at 80% of realtime and this is the outage rather than the hour before it.

**Known limitation, documented on the rule.** This cannot see the shared worker
saturating under concurrency. RTF's denominator is the audio ingested by that pass,
and overrun periods are dropped whole, so duty ratio *falls* as sessions pile onto
one worker: measured 0.277 / 0.256 / 0.229 / 0.194 / 0.139 at 1/2/3/5/8 sessions
while the worker went 26% to 94.5% busy and transcripts per 1000 chunks collapsed
190 to 48. A quiet duty ratio is therefore not evidence transcription is keeping up.
The metric with the right slope is the worker busy fraction, already on the wire;
nothing watches it yet.
