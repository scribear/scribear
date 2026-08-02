---
'@scribear/monitoring-sidecar': minor
'@scribear/admin-server': patch
---

The monitoring sidecar now selects the `asrDutyRatio` alert threshold per
provider based on the inference device the transcription service reports,
instead of using one global GPU-calibrated number for every deployment.

A GPU provider keeps the existing 0.45 default. A CPU provider gets 0.7 — the
value that was previously a manual `.env` override every CPU deployment had to
discover for itself. A healthy CPU stack running `small`/4 measured 0.471,
sitting exactly on the GPU alarm; the shipped `base` template measures 0.173.
One global threshold cannot serve hardware an order of magnitude apart.

The transcription service now reports `providerDevice` on `/metrics/status`
(alongside `providerJobPeriodMs`), using the same reported-then-fallback
shape: the sidecar prefers it, falls back to the GPU default for a service too
old to send it (rolling upgrade), and a provider with no local device (`debug`,
`lumen_granite`) is omitted from the map.

The flat operator override `MONITORING_ASR_DUTY_RATIO` still wins over both
per-device defaults, preserving the existing escape hatch. A new env var
`MONITORING_ASR_DUTY_RATIO_CPU` (default 0.7) lets an operator tune the CPU
default without affecting GPU providers.
