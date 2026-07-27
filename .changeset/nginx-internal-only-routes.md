---
'@scribear/scribear-nginx': minor
---

Stop the public reverse proxy from forwarding two routes their own schemas
describe as cluster-internal.

`GET /api/node-server/v1/status` is documented in
`libs/schemas/node-server-schema/src/status/routes/status.schema.ts` as
"intended for internal observability consumers (Monitoring Sidecar, Admin
Server) on the cluster-internal network; it must not be exposed through the
public reverse proxy", and the same sentence is restated in the schema's tag
description, in two CHANGELOGs, and in the sidecar's operator-facing alert text
("check it is reachable on the internal network (it must not be exposed through
nginx)"). Nothing enforced it. `location /api/node-server/` forwards the whole
prefix, so the endpoint answered 200 through the public origin with the service
key and 401 without it — an internal telemetry surface carrying session uids,
room uids and per-process counters, on the internet behind one shared static
secret. Verified against a running stack before the fix, both status codes.

`GET /api/session-manager/v1/schedule-management/session-config-stream/:sessionUid`
is the same shape of mistake with quieter wording: it is guarded by the *service*
key rather than the admin key or a device token, and that key's schema says it is
"used by sibling services (Session Stream Server) to consume internal APIs". It
too sat on a publicly forwarded prefix.

Both are now shadowed by `location ^~ ...` blocks that `return 404`. Nothing
breaks: every real consumer reaches its service directly over the `backend`
compose network — the sidecar and admin-server via
`NODE_SERVER_BASE_URL=http://node-server:80`, node-server via
`SESSION_MANAGER_BASE_URL=http://session-manager:80` — so none of them traverse
nginx at all. Nothing in the repo, tests and `tools/` scripts included, fetches
either path through an nginx origin.

404 rather than `deny all`'s 403, because a 403 confirms the route exists and
merely withholds it, which is the one fact an unauthenticated prober is after;
and rather than 401, which would invite key guessing. Prefix matches rather than
exact ones, so a trailing slash or a future sub-path (`/status/sessions`) does
not quietly become public again.

Rejected: leaving both to their service API keys, as before — one static
unrotated key with no rate limit is a thin last line, and the schema does not
say "exposed but authenticated". Rejected: `allow`/`deny` on the compose subnets
— internal callers never traverse nginx, so the allowlist would match nobody and
would break whenever compose renumbered. Rejected: moving the routes off the
`/api/...` prefixes onto a separate port or an `/internal/` base path, which is
the more robust fix but changes the schema contract every generated client
derives its URLs from, and is not a decision the proxy config gets to make.

Left alone deliberately: `/api/session-manager/v1/database/schema`, whose schema
already reasons explicitly about sitting on a public prefix and uses the admin
key as the control; the unauthenticated `probes/*` routes, which container
orchestration needs; and every monitoring-sidecar and transcription-service
route, which have no nginx upstream at all and so were never reachable.
