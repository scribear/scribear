---
'@scribear/monitoring-sidecar': minor
---

Stop silently misscaling `scribear_asr_period_utilization`, and make the job
period per provider.

The derived period-utilization series divides reported job execution time by
`TRANSCRIPTION_JOB_PERIOD_MS`, a single sidecar env var that defaulted to 1000.
`job_period_ms` is a **per-provider** field of transcription-service's
`provider_config.json`, and the shipped CUDA template
(`deployment/provider_config.cuda.template.json`) configures three different
values in one file: `whisper` and `crisper_whisper` at 500 ms, `lumen_granite` at
3000 ms. (`debug` has no such field at all — its period is hardcoded to 1000 ms
in `debug_provider.py`, which is the only provider the old default was ever right
for.) So the default matched none of the configured providers and the series was
published 2x high for whisper and 3x low for lumen_granite, with no error, no
warning and no way to tell from the number itself. Worse, the two statements of
the period live in different files edited by different people at different times,
so agreement was a coincidence rather than an invariant.

`TRANSCRIPTION_JOB_PERIOD_MS` is now a per-provider map —
`whisper=500,lumen_granite=3000` — with **no default**, and each provider's
series is scaled by its own period. A provider that is not named publishes no
period-utilization series at all, rather than one scaled by a guess: "no reading"
is not the same claim as a bad reading, the same rule the fleet dashboard applies
to audio status. A bare integer, the format this variable used to take, is
rejected with an error naming the replacement instead of being applied to every
provider. **Deployments must update this value**; `deployment/compose.yml` still
passes `${MONITORING_JOB_PERIOD_MS:-1000}`, which the sidecar now logs as an
error and treats as "no periods configured".

Nothing else changes behaviour. `scribear_asr_rtf`, the T1 saturation rule and
the new duty-ratio counters are measured by transcription-service itself and
carry no dependency on the job period — that independence is why the T1 early
warning was built on RTF, and it is preserved here.

Two new pieces of visibility, because a suppressed series is invisible by
construction:

- `scribear_asr_job_period_ms{providerKey,source}` exports the denominator
  actually in use and where it came from (`configured` or `reported`). The period
  is the one dashboard input the sidecar cannot verify, so publishing it beside
  the ratio turns "silently wrong" into "visibly derived from 1000 ms, which is
  not what the provider config says". Its absence for a provider is the honest
  signal that no period is known.
- A once-per-provider warning naming the provider and the variable, plus an error
  per rejected entry. Deliberately not an alert rule: `asrPeriodUtilization` is
  not alerted on at all, so an alert about its denominator would page on config
  hygiene while nothing consumes the series it protects.

The real fix is for transcription-service to report the periods it is scheduling
with, so the number is stated once. `GET /metrics/status` does not carry them
today (nor does `GET /providers/health`, nor the Redis fleet plane), so the body
schema gains an **optional** `providerJobPeriodMs` map and the poller prefers it
over anything configured locally, per provider. When
`metrics_controller.py` starts sending it, `TRANSCRIPTION_JOB_PERIOD_MS` can be
deleted with no further sidecar change; optional rather than required so landing
the two sides in either order never turns a healthy poll into a `malformed` one.
