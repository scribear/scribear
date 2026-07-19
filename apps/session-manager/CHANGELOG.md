# @scribear/session-manager

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
