---
'@scribear/admin-webapp': patch
---

A transcription session no longer takes a worker's job slot until it actually
sends audio — and the capacity estimate on the fleet view drops sharply as a
result.

**The bug.** A session registered its worker-pool job as part of its own
construction, at CONFIG time. So a client that connected, configured, and then
streamed nothing occupied a worker identically to one transcribing a lecture: it
counted toward `live_job_count`, and the worker ran an empty batch for it every
period. Enough idle connections could refuse a genuinely busy worker's next real
session — or refuse each other — with no relationship to transcription load at
all. Observed as flaky refusals nobody could tie to usage.

Registration now happens on a session's own first `handle_audio_chunk` (each
provider's `_ensure_job`). An audio-less connection registers nothing and is a
claim on nothing. `TranscriptionProviderRegistry.create_session` therefore
**never raises `TranscriptionCapacityError`** any more; a refusal surfaces from
the audio path instead and still closes **1013**, which the node server already
reads as "refused" rather than "crashed".

**Admission enforcement stays off, deliberately.** `create_webserver` passes no
estimator to the provider registry, so the estimator observes, records and
publishes but nothing is ever refused. The fix above is unambiguously correct on
its own, but it also *lowers* the measured ceiling and by a wide margin: idle
registered jobs used to run an empty batch every period, adding a distinct
`job_id` to the estimator's window and inflating the `sessions` denominator of
`cost_per_session = busy / sessions` while contributing nothing to the numerator.
A live box measured `estimatedCapacitySessions: 50` under that inflation; with it
removed, one whisper stream that keeps the single worker busy for half of each
5000 ms period gives `N* = 1`. Shipping enforcement in the same change as the fix
that moved the number would mean enforcing a ceiling nobody has watched under
real load, and a wrong refusal is invisible to the user and unrecoverable for
that session. So: measure in shadow mode first, on
`/metrics/status`, `/providers/health` and **Dashboard → fleet view**, then
decide.

**Expect the fleet view's "estimated capacity" to fall.** That is the inflation
going away, not capacity being lost. Nothing is refused either before or after.

The register/ask/undo sequence is now one implementation on
`TranscriptionSessionInterface` rather than three call sites. Only
`whisper-streaming` wrapped `check_admission` in the deregistration a refusal has
to undo; `debug` and `lumen_granite` called it bare, which was safe only for as
long as neither of them overrode `admission_worker_id` — an invariant asserted in
three docstrings and enforced nowhere, where the failure would have been a job
registered forever against a session no client ever received.
