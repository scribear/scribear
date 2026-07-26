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
