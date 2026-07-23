---
'@scribear/monitoring-sidecar': minor
---

Add the standalone audio meter (Part A item A4) to the monitoring sidecar.

The meter is a single self-contained HTML page — no imports, no build step and
no network access of any kind. An audio engineer can copy it onto the source
machine and open it straight from `file://`, which is the point: the whole
value of A4 is being able to measure a room's input when the pipeline is the
thing under suspicion. It picks up the same microphone the source browser
would, and it uses an AudioWorklet where one is available, falling back to a
`ScriptProcessorNode` when the blob worklet module is refused (as it is under
`file://`), with identical readings either way.

It reports RMS and fast RMS, sample peak with hold and decay, true (inter-
sample) peak, clipping percentage, noise floor, a silence flag, and K-weighted
loudness — momentary, short-term and gated integrated LUFS — plus short-term
level against the loudness target in LU. Selectable conventions: dBFS reference
(plain or AES17), loudness target, peak zone boundaries and silence threshold.
SNR is deliberately absent; it needs voice-activity detection, which arrives
with the service-side DSP work in Part B.

The page's DSP is isolated in one DOM-free script block, and the unit suite
extracts and evaluates that same block rather than a copy, so the shipped
maths and the tested maths cannot drift. Gate A4 is verified end to end: a
−18 dBFS alignment tone reads within ±0.5 dB on both audio paths.

The sidecar also serves the page at `GET /api/monitoring/v1/audio-meter` as a
convenience. That is a convenience only — the sidecar is not exposed through
nginx, so reaching that URL from a source room needs a port-forward or an
nginx rule. If the page file is missing the route is simply dropped with a
warning rather than failing startup.
