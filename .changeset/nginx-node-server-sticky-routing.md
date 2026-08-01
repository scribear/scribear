---
'@scribear/scribear-nginx': patch
'@scribear/node-server': patch
---

`upstream node-server` had no balancing directive, so nginx round-robined a
service whose state is per-process.

`TranscriptionOrchestratorService`'s own class doc asserts the opposite:
"Sticky URL routing pins all connections for a given sessionUid to one Node
Server instance, so the singleton state for a session is always co-located with
the source connections feeding it." The event bus is in-process, and a session's
upstream transcription connection lives on whichever instance its *source*
reached. A viewer routed elsewhere subscribes to a channel nothing publishes on
and receives no transcripts — no error, no close, no banner, just an empty
caption view. `docker compose up -d --scale node-server=2` was one word away,
and nothing about that word looks like it could break captioning.

The upstream now hashes on `$node_server_session_uid`, a `map` over `$uri` that
captures the session uid from the shared
`/api/node-server/v1/transcription-stream/<sessionUid>/{source,client}` prefix —
which is precisely why the route schema puts the uid in the path: "The session
UID is carried in the URL so the L7 proxy can sticky-route every connection for
a session to the same Node Server instance." `$uri` rather than `$request_uri`
so a trailing query string or an encoded path segment cannot send a second
connection for one session to a different peer.

**`consistent` is deliberately absent, and that is a measurement, not a
preference.** Ketama is the better algorithm here — a peer joining remaps ~1/N
of sessions instead of most of them — but it is silently ignored when the
upstream's server is a `resolve` name, which `node-server`'s is. Verified
against `nginx:1.29.7-alpine3.23` (this image's base) with two backends behind
one docker network alias, requesting one session uid repeatedly:

```
hash $node_server_session_uid consistent;   ->  B A B A B A B A     (round-robin)
hash $node_server_session_uid;              ->  B B B B B B B B
```

`nginx -t` passes on both, and at one replica both behave identically — a
`consistent` version of this fix would have merged green and done nothing. The
final config was then re-verified verbatim from the repo: two uids held on two
different peers across 12s and several `valid=5s` re-resolutions, with the
WebSocket upgrade headers set, and `source` and `client` for the same uid always
landing together. The cost of plain modulo hashing is that changing the replica
count re-homes most sessions; that happens on a deploy, when every connection is
being re-established anyway.

Three unit tests in node-server read the shipped config — same precedent as
`nginx-status-not-public.test.ts` — and fail if the `hash` directive is dropped,
if `consistent` is reintroduced, or if the map stops matching the routes it
derives from the route definitions. `UPGRADING.md` records that scaling
node-server past one replica is now supported, and was not before.
