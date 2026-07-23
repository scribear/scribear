---
'@scribear/node-server': patch
'@scribear/session-manager': patch
---

Make an upgrade that carries over a pre-monitoring `.env` fail loudly instead of
silently coming up insecure, and document the upgrade in
`deployment/UPGRADING.md`.

`deployment/.env` is untracked, so it does not update when an operator pulls.
The monitoring/fleet release adds two required secrets — `NODE_SERVER_SERVICE_KEY`
and `REDIS_PASSWORD` — and Compose substitutes a blank string for an unset
variable rather than erroring. Both blanks fail *open*:

- `redis-server --requirepass ""` is not a password-protected server that
  rejects logins, it is an open server that accepts every unauthenticated
  command — and it would be holding the whole fleet's operational state.
- An empty `NODE_SERVER_SERVICE_API_KEY` compares equal, via
  `constantTimeEqual`, to the empty string a caller presents as
  `Authorization: Bearer `, so the inbound service-auth guard admits
  unauthenticated requests to node-server's internal routes.

Verified against a `.env` taken from before the release: `docker compose up`
previously emitted two "variable is not set, defaulting to a blank string"
warnings and proceeded. Those two variables now use Compose's `${VAR:?message}`
form, so interpolation fails and the stack aborts before any container starts,
naming the file to read. The message is repeated at every use site rather than
abbreviated at some, because Compose reports only the first failure it reaches
and it walks services alphabetically — the sidecar's copy fires before the node
server's.

`assertNotPlaceholderKey` now rejects the empty string alongside `CHANGEME`, in
both node-server and session-manager, so the same misconfiguration is caught at
boot on deployments that do not use Compose at all. Both copies of the util are
kept byte-identical, as before.

It also now matches `CHANGEME` as a case-insensitive **substring** rather than
by equality. Only some of the stubs in `.env.example` are the bare word; the
rest carry a suffix that exists purely to satisfy a minimum-length rule —
`CHANGEME-JWT-must-be-at-least-32-characters-long`,
`CHANGEME-admin-session-secret-at-least-32-characters` — or sit inside a larger
value, `ADMIN_LOCAL_CREDENTIALS=engrit CHANGEME`. An equality check passed all
three, which is exactly backwards: a length rule pushes an operator to keep
those stubs verbatim rather than invent a long one, so they were the stubs most
likely to survive into a deployment and the only ones the guard ignored.

transcription-service had the same empty-key bypass and no guard at all:
`AuthService.is_authenticated` compared with `==`, so an empty `API_KEY`
authenticated any caller presenting no key, and the comparison leaked the shared
prefix length through timing. It now refuses to construct on an empty or
placeholder key and compares with `hmac.compare_digest`, matching what
`MetricsAuthService` in the same package already did. (`METRICS_API_KEY` was
already correct — empty means the route is never registered, which is a genuine
disabled state rather than an open one.)

This is defence in depth for one misconfiguration, not two mechanisms for two
problems: Compose stops the common case early and with the better message, and
the boot-time assertion covers the paths Compose never sees.
