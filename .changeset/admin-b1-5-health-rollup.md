---
'@scribear/admin-server': major
'@scribear/admin-webapp': major
---

Extend the admin `/health` rollup to every service, with real timeouts (B1.5).

The rollup checked only the database and session-manager. It now also checks
node-server and transcription-service, reading their unauthenticated readiness
probes concurrently.

**Fixes a hang.** The session-manager check went through the generated client,
which issues a bare `fetch` with no `AbortSignal` unless a caller passes one —
and the health path did not. A hung session-manager could stall the route for
the OS TCP timeout with an admin waiting on it. Every component now has a hard
`HEALTH_CHECK_TIMEOUT_SEC` (default 3s).

**Breaking response shape.** `sessionManager` / `sessionManagerLatencyMs` /
`database` are replaced by a `components` list of
`{ name, status, latencyMs, detail? }`. Flat per-service keys meant every new
dependency needed a server change, an SPA type change and a new hardcoded tile;
the dashboard and health chip now render from the list. A 503 readiness is now
reported as `fail` rather than `degraded` — the service answered and said it is
unhealthy — and the readiness `checks` map, previously discarded, is surfaced as
the component's `detail`.

New env: `NODE_SERVER_BASE_URL`, `TRANSCRIPTION_SERVICE_BASE_URL`,
`HEALTH_CHECK_TIMEOUT_SEC`.
