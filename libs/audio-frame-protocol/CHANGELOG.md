# @scribear/audio-frame-protocol

## 0.3.0

## 0.2.0

## 0.1.0

### Minor Changes

- Add end-to-end latency metrics on the new architecture.
  - New `@scribear/audio-frame-protocol` package: a versioned, self-describing
    binary frame format (magic + version + TLV fields + trailing CRC-32) with a
    mirrored Python implementation in `transcription_service`, replacing
    fixed-offset framing so client and server can evolve independently.
  - `node-server`'s transcription orchestrator stamps and forwards clock-sync /
    latency events end-to-end through the transcription stream pipeline.
  - `client-webapp` and `kiosk-webapp` surface live latency in the session UI
    (new `latency-badge` component, kiosk/client session services wired to the
    new events).

  See `TOBEREVIEWED.md` for the architectural notes carried over from the
  latency-metrics-v2 rework (PR #124, superseding #67).
