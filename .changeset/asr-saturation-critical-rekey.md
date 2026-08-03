---
'@scribear/monitoring-sidecar': minor
---

Re-key the T1 saturation CRITICAL onto the dropped-period share, and stop
flooring a share on a count the share erodes.

**The signal was wrong in kind, not merely mis-thresholded.** `asr-saturation`
fired on `asrRtf{quantile=p95}`, which is the obvious "transcription is slower
than realtime" number and which _falls as the service saturates_. RTF's
denominator is the audio a pass ingested; a dropped period leaves that audio for
the next pass to swallow, so per-pass cost amortises over a longer buffer.
Measured at 1/2/3/5/8 concurrent sessions on one worker: mean RTF 0.277 → 0.256
→ 0.229 → 0.194 → 0.139 while the worker went 26% → 94.5% busy and transcripts
per 1000 chunks collapsed 190 → 48. At eight sessions captions were badly behind
and the alert was not merely silent — it was moving further from firing.

The threshold had already been raised 1.0 → 2.0 in the previous release, because
1.0 fired on a _healthy_ single session (measured p95 0.96–1.28). That is the
same fact from the other side: on this signal the healthy and the saturated
values interleave, so no bar separates them. Raising it bought silence, not
correctness, and the changeset that did it said so.

`asr_dropped_periods_total` measures the thing exactly and has the right slope —
it rose monotonically through the same sweep. The CRITICAL is now keyed on the
share of scheduled periods that ran no pass at all, at **0.5**: between the
3-session point (26.4%, transcripts down ~19%) and the 6-session one (66.3%,
transcripts collapsed), and 4.4× the measured healthy share of 11.3%. The
warning below it keeps 0.25, so the two rules now read one quantity at two bars
and suppression between them is a plain numeric ordering rather than a judgement
about two different metrics.

`ALERT_RTF_P95` survives only as the fallback for a transcription-service too old
to report the counter — the same shape, and the same rolling-upgrade argument, as
the tail rule's existing p99 fallback. Both can be deleted together once no such
service is polled. Without it, a rolling upgrade would silently have no T1
CRITICAL at all.

**A pass floor on a rule about dropped passes.** Both dropped-period paths were
floored at 100 _passes_ in the window. Dropping a period removes a pass, so that
floor rises out of reach exactly as the fault it guards gets worse — the same
wrong slope, reintroduced in the guard. It was also unreachable outright for any
long period: a 120 s window holds ~24 scheduled periods at the CPU templates'
5000 ms `job_period_ms` (measured on a live CPU stack) and ~40 at
`lumen_granite`'s 3000 ms, so the tail alert was **silently inactive on every CPU
deployment** and on that provider.

The floor is now split by what each path actually measures. The counter paths
take `ALERT_ASR_SCHEDULED_PERIOD_MIN_COUNT` (20 scheduled periods, `drops +
passes` — a total that dropping does not move). The p99 fallback keeps
`ALERT_ASR_TAIL_MIN_JOBS` at 100 passes, where the argument is about percentile
resolution and genuinely applies. 20 rather than 100 because the second reason
for 100 — stopping a _1%_ threshold firing on one dropped period — expired when
that threshold became 0.25; at 20 scheduled periods the warning needs 5 drops and
the critical 10.

**Also fixed: `ALERT_RTF_P95` did not default to its own default.** Its schema
said `Type.Number({default: 1.0})` while `DEFAULT_THRESHOLDS.rtfP95` said 2.0,
and unlike its neighbours it did not use the `OPTIONAL_NUMBER`/`threshold()`
pattern — so the schema default won and any deployment that left the variable
unset got exactly the 1.0 that live verification had shown fires on a healthy
stack. It now falls back to the compiled default like every other threshold, and
`.env.example` ships it empty so the number lives in one place.

**Also fixed: the first poll folded a polled service's entire lifetime.**
`AbsoluteStatusPoller._advance` differences each absolute total against the
previous reading, defaulting to 0 when it has never seen the series. On the
sidecar's *first* poll that default is wrong in one specific way: the service it
is polling may have been up for days, so its whole history landed as a single
increment stamped `now`. Every raw windowed rule then fired immediately —
`decodeDropRule` at 10, `bufferOverflowRule` at 5, `upstreamChurnRule` at 3 — on
events that predate the sidecar, and cleared itself one window later. The ratio
rules were already immune, because a lifetime fold lands in numerator and
denominator together.

The first successful poll now records baselines without emitting increments.
Gauges are unaffected, so a primed poll still publishes a full picture of current
state; only counter deltas are skipped, and the cost is up to one poll interval
of counts at startup — which is the correct answer for a rate rule, since those
counts happened before anyone was watching. A *service* restart is the opposite
case and still folds in full: the baselines are cleared on a `processUid` change
and the service's own counters really are near zero then.

New: `ALERT_ASR_DROPPED_PERIOD_CRITICAL_RATIO`,
`ALERT_ASR_SCHEDULED_PERIOD_MIN_COUNT`, both plumbed through `compose.yml`.
