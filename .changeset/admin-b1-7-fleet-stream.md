---
'@scribear/scribear-redis': minor
'@scribear/node-server': minor
'@scribear/admin-server': minor
---

Add `GET /api/admin/v1/fleet/stream` (B1.7 part 2.5): sub-second session
status pushes over SSE, instead of waiting for the next 2 s heartbeat.

Node Server's `_setStatus` — already the single edge-triggered writer of a
session's connectivity — now also publishes each transition to a new
in-process event bus channel. `RedisTelemetryPublisher` subscribes to it only
once telemetry is switched on, and forwards each delta to a new Redis pub/sub
channel, `scribe:v1:events`, on its existing heartbeat connection. No new
Redis connection on Node Server, and no new dependency on the orchestrator:
routing the delta through the in-process bus is what keeps a Redis-touching
class out of a code path that resolves on every session regardless of
`REDIS_URL`.

`scribear-redis` gains the channel's contract: a `Type.Union` schema
discriminated by `t`, with only the `session` variant defined today — a
`node`/`provider` variant belongs there once something actually publishes
one, not before.

admin-server gains `FleetEventsService`, the first real consumer of the
typed `createRedisSubscriber` this package restored in B1.7 part 2a: it
subscribes once and fans every message out to connected SSE clients. The
route answers 503 `TELEMETRY_UNAVAILABLE` before hijacking the response when
`REDIS_URL` is unset, matching `GET /api/admin/v1/fleet`'s existing shape —
after hijacking there is no envelope left to send. Requires an authed
session cookie, same as every other admin route; a same-origin `EventSource`
sends it automatically.

Also fixes a real bug in `scribear-redis`'s `createRedisSubscriber`:
`disconnect()` called `redis.quit()`, an ordinary command that queues behind
the subscription already issued on construction and can hang forever against
an unreachable or misconfigured Redis. Switched to the synchronous
`redis.disconnect()` — nothing on a connection being torn down is worth
waiting for. Safe to change: nothing else called this factory yet.

No new env var — the SSE subscriber reuses admin-server's existing
`REDIS_URL`. `infra/scribear-nginx`'s `nginx.conf` gains an exact-match
`location = /api/admin/v1/fleet/stream` with buffering disabled and a long
read timeout, since the general `/api/admin/` block is deliberately left
alone for every other (bounded) admin route.
