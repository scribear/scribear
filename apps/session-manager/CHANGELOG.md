# @scribear/session-manager

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

### Patch Changes

- 08c0401: Make an upgrade that carries over a pre-monitoring `.env` fail loudly instead of
  silently coming up insecure, and document the upgrade in
  `deployment/UPGRADING.md`.

  `deployment/.env` is untracked, so it does not update when an operator pulls.
  The monitoring/fleet release adds two required secrets — `NODE_SERVER_SERVICE_KEY`
  and `REDIS_PASSWORD` — and Compose substitutes a blank string for an unset
  variable rather than erroring. Both blanks fail _open_:
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

## 0.1.0

### Patch Changes

- b34905f: Harden Session Manager credential handling (admin website Phase 6):
  - Compare the admin and service API keys in constant time
    (`crypto.timingSafeEqual` over HMAC digests) instead of `===`, closing a
    timing side-channel.
  - Refuse to start when `ADMIN_API_KEY` / `SESSION_MANAGER_SERVICE_API_KEY` is
    still the literal placeholder `CHANGEME`.
  - Rate-limit the two unauthenticated credential-exchange routes
    (`exchange-join-code`, `refresh-session-token`) per client IP via
    `@fastify/rate-limit` (long-poll, probe, and admin/service routes are
    intentionally not limited). `trustProxy` is enabled so the limit keys on the
    real client IP behind nginx.

  No change to the wire contract.

- Bump `testcontainers` 11 -> 12 (dev-only integration-test dependency) to drop
  the transitive `uuid@10.0.0` pull that was the last live Dependabot alert
  (GHSA-w5hq-g745-h8pq). No production runtime change; `npm audit` now reports 0
  vulnerabilities. Integration suites re-verified: session-manager (308),
  admin-server (19), node-server (17).
