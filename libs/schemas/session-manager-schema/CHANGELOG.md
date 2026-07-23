# @scribear/session-manager-schema

## 0.2.0

### Minor Changes

- cef5888: Track device `lastSeenAt` and derive online/offline state (B1.6).

  Devices are stamped in the device-token hook, so presence covers every
  device-authenticated route rather than only the schedule long poll. Writes are
  coalesced to at most one per device per `DEVICE_LAST_SEEN_WRITE_INTERVAL_SEC`
  (default 60s) and are fire-and-forget, so a failed write never turns a working
  device request into a 500.

  `Device` gains `lastSeenAt` (nullable) and `online`, derived server-side against
  `DEVICE_ONLINE_TTL_SEC` (default 180s) so every consumer agrees on one cutoff.
  The admin devices list gains a Presence column. Admin-server needs no change —
  its device routes are a generic passthrough.

  New migration `00000011-device-last-seen`. The column is nullable with no
  backfill: NULL means "not heard from since this shipped", which is honest, where
  defaulting to `now()` would have shown the whole fleet as freshly online.

## 0.1.0
