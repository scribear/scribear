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

This is defence in depth for one misconfiguration, not two mechanisms for two
problems: Compose stops the common case early and with the better message, and
the boot-time assertion covers the paths Compose never sees.
