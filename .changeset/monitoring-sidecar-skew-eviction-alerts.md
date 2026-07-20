---
'@scribear/monitoring-sidecar': minor
---

Alert on the two signals B1.1 started collecting but nothing evaluated, and fix
the S2 denominator.

`clockSkewRule` (§3 S5) fires when a large share of latency samples come back
with a negative end-to-end time, meaning source clocks are ahead of
node-server's despite sync. This is worth its own alert precisely because it is
invisible otherwise: captions are unaffected and pipeline latency still reports,
so the only symptom is an end-to-end panel that quietly stops being populated.
It is a ratio with a minimum sample count, because a couple of odd devices are
noise while a large fraction is a deployment fault.

`pendingChunkEvictionRule` (§3 N3) fires when audio frames are evicted from the
correlation map before their transcript returns. The captions are fine; what
degrades is the latency measurement, and it degrades in the most misleading
possible direction — the frames being dropped are the slow ones, so the
remaining numbers look healthier than reality.

`authFailureRule` now divides by auth *attempts* rather than by all WebSocket
closes. Attempts are what the plan specifies for S2, and they only became
available with B1.1's status endpoint; dividing by every close includes normal
end-of-session traffic, which drags the ratio down and can hide real signing-key
drift entirely. The close-based form is kept as a fallback for deployments
running without status polling, where it remains the only thing available.

All three thresholds are configurable, as every threshold in this service is.
