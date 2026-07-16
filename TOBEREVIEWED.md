# TOBEREVIEWED — Latency Metrics (re-port of PR #67)

This document flags items the team should review before considering the
end-to-end latency feature production-ready. It accompanies the re-implementation
of PR #67 (`latency-metrics`) onto the current `staging` architecture.

## Context: this was a re-implementation, not a merge

PR #67 was written against an architecture `staging` has since replaced
wholesale:

- the node-server was rewritten (event-bus + orchestrator + schema-driven
  upstream client);
- the bespoke `transcription-service-client` lib was **deleted** in favour of
  `@scribear/base-websocket-client` + shared schema packages;
- `apps/webapp` was **split** into `apps/client-webapp` + `apps/kiosk-webapp`;
- the Python worker-pool / provider registry was refactored.

None of PR #67's ~42 files applied cleanly, and the new pipeline carried **no
chunk-id or timestamp** to hang latency off of. The feature was therefore
rebuilt on the new architecture rather than conflict-merged. This rebuild ships
as **PR #124** (branch `latency-metrics-v2` → `staging`); the original **PR #67
has been closed as superseded**.

## What the feature does now

- **Kiosk** frames each audio chunk in a versioned, self-describing binary
  envelope (`@scribear/audio-frame-protocol`, "SAFP" v1: magic + version + TLV
  fields + CRC-32) carrying a `chunkId` and, once the clock is synced, a
  clock-corrected `sentAt`.
- **Node server** decodes the frame, keeps a per-session `chunkId → {recvMono, sentAt}`
  map, forwards audio upstream, and on each transcript correlates the echoed
  `chunk_ids` to emit two latency numbers:
  - `pipelineMs` — measured entirely on the node's **monotonic** clock (skew-free);
  - `e2eMs` — includes capture + uplink, using the source's clock-corrected
    `sentAt`; `null` until a clock offset is available.
- **Clock sync** uses Cristian's algorithm over the source WebSocket
  (`timeSyncPing`/`timeSyncPong`), keeping the lowest-RTT sample from a sliding
  window.
- **Client webapp** renders a 60-sample moving average of both metrics
  (final / interim).

## Deliberately NOT ported (flagged, low risk to omit)

1. **VAD / silence-threshold tuning in `provider_config`.** PR #67 exposed
   `vad_detector`, `vad_threshold`, `vad_neg_threshold`, `silence_threshold`
   in the whisper provider config template. `staging` independently rewrote the
   provider-config format and the worker pool; those knobs already exist as
   fields on `WhisperStreamingProviderConfig` (with defaults) but are not
   surfaced in `provider_config.template.json`. Re-adding them was skipped to
   avoid regressing `staging`'s VAD/worker-pool rework. **Review:** if runtime
   VAD tuning is wanted, add the keys to the template and validate against the
   current schema — this is orthogonal to latency.

2. **Python internal stage-timing diagnostics (`LatencyTracker` / `processing_stats`).**
   PR #67 added per-batch VAD/ASR stage timers that were **never forwarded to
   clients** (dev-only). Omitted: they add hot-path work in the whisper job for
   no user-facing value. **Review:** if backend perf diagnostics are wanted,
   prefer structured logging/metrics over a payload field.

## Production concerns to review

3. **Clock skew is the main correctness risk for `e2eMs`.** The node-domain
   `pipelineMs` is the trustworthy number and should be what any alerting keys
   on. `e2eMs` depends on Cristian's offset, which is biased by **asymmetric**
   up/down network latency by roughly `(up − down) / 2`. Mitigations in place:
   min-RTT sample selection, a monotonic-anchored `sentAt` on the kiosk,
   discarding negative `e2eMs`, and reporting `null` until synced. **Review:**
   treat `e2eMs` as indicative, not authoritative.

4. **Observability of dropped frames.** A frame that fails CRC/version/magic is
   dropped with a `warn` log on both the node and Python sides. A systematic
   framing/version mismatch would **silently stop audio** with only warn logs.
   **Recommend:** add a metric/alert on the decode-drop rate (node
   `dropping malformed audio frame`, Python `Dropping malformed audio frame`).

5. **`timeSyncPing` is answered before auth and is not rate-limited.** A
   connected-but-unauthenticated peer can elicit `timeSyncPong` replies. It only
   leaks the server wall clock and is cheap, but it is an unauthenticated
   request surface. **Review:** consider gating on auth and/or a simple rate
   limit if this matters for the threat model.

6. **`pendingChunks` bound.** Capped at `MAX_PENDING_CHUNKS = 2000` per session,
   pruned on final transcripts; the oldest entry is evicted when full. At the
   kiosk's ~10 frames/s that is ~200 s of un-finalized backlog. **Review:**
   confirm the cap suits the real frame cadence and finalization interval.

7. **Per-frame CRC-32 cost.** CRC is computed at encode (kiosk) and decode
   (node + Python). Negligible at current size/rate (~3 KB, ~10/s) and it is
   defense-in-depth on top of TCP/WS integrity. **Review:** if frame size/rate
   grows a lot, profile — or make CRC optional via a future SAFP flag.

8. **`chunkId` wire size.** Currently a 36-byte UUID string per frame. The
   versioned protocol makes shrinking it (16-byte raw UUID, or a per-connection
   counter) a **non-breaking** change if uplink bandwidth ever matters.
   Low priority.

9. **Latency fan-out.** `latencyUpdate` is broadcast to every subscriber of a
   session (same fan-out as transcripts). No new scaling concern, but note that
   large rooms multiply these small messages.
