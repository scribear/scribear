---
'@scribear/monitoring-sidecar': minor
---

Add the synthetic canary (Part A item A2) to the monitoring sidecar.

The canary authenticates as a registered ScribeAR device, joins the session
active in that device's room, streams a known recording as a source using the
real SAFP encoder, subscribes as a viewer on the `/client` route, and scores
the captions that come back against the fixture's reference text.

This is the first signal in the sidecar derived from actively exercising the
pipeline rather than observing it: log parsing and probes can both report green
while viewers receive nothing, and the canary is what catches that.

New metrics (`scribear_canary_*`): run outcomes, time-to-first-transcript,
word recall and precision, repetition ratio, pipeline and e2e latency
percentiles, and clock-sync state. Two new alert rules — one for outright
failure, one for degraded-but-flowing captions — plus C6 clock-sync detection.

Disabled by default. It requires `CANARY_DEVICE_TOKEN`; without it the canary
does not run. The device must belong to a dedicated canary room, since the
canary streams synthetic speech into a real session. It deliberately holds no
admin API key and no token-signing key, so it cannot reach any other room.
