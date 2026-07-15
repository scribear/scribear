---
'@scribear/session-manager': patch
---

Harden Session Manager credential handling (admin website Phase 6):

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
