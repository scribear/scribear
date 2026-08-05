# @scribear/node-server-client

## 0.3.0

### Minor Changes

- 64a2a70: Stop replaying stale audio onto a reconnected source socket.

  The send queue buffers up to 64 messages while the socket is down and flushes
  every one of them the instant it reopens. On the source route that queue is
  audio: microphone capture keeps running across a reconnect, because the
  capture callback has no idea the socket dropped. A reconnect therefore
  delivered up to 6.4 s of audio the room finished saying seconds earlier, in
  one burst, as if it were current.

  `WebSocketClient` gains an opt-in `sendQueueMaxAgeMs`. Buffered messages older
  than it are dropped at flush time rather than sent. The default is unchanged —
  unset means never expire, which is right for a control channel where a late
  message still matters.

  The node-server **source** route sets it to 1 s. Everything a source sends is
  time-critical: a queued `timeSyncPing` carries the client clock reading from
  when it was queued, so a stale one poisons the offset it exists to measure,
  and `sourceState` is re-seeded on every open anyway. The client route and
  every other consumer are unaffected.

  Dropped messages are now counted and readable via `sendQueueDrops`, overflow
  included — previously both were entirely silent, and a client dropping every
  frame looks from the far end exactly like a client with nothing to say.

## 0.2.0

## 0.1.0
