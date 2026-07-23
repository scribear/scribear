# @scribear/admin-server

## 0.1.0

### Minor Changes

- b34905f: Add the ScribeAR Admin website foundation (PLAN-ADMIN Phase 0–1).
  - **`apps/admin-server`** — a Fastify Backend-for-Frontend that holds the
    Session Manager admin key server-side and exposes `/api/admin/v1`. Includes:
    a pluggable auth layer (local single-account provider now via
    `ADMIN_LOCAL_CREDENTIALS`, constant-time compare; Azure OIDC stub for later);
    server-side revocable sessions (HttpOnly + Secure + SameSite=Strict signed
    cookie) with a session-bound CSRF token; per-route rate limiting (strict on
    login); a Session Manager gateway that is the single place the admin key is
    used and injected; a consistent `{ ok, data?, error? }` response envelope;
    rooms + devices proxy/task endpoints with read-only/read-write role gating;
    a `/health` rollup; and a Postgres-backed append-only admin audit log
    (own migration + migration-tracking tables).
  - **`apps/admin-webapp`** — a minimal React SPA placeholder (build + healthcheck)
    to be built out in later phases.

  Both workspaces are wired into the monorepo (workspaces auto-discovery,
  tsconfig project references) with unit + integration tests. Deployment
  (compose/nginx/CI) and the full SPA UI land in later phases.

### Patch Changes

- Bump `testcontainers` 11 -> 12 (dev-only integration-test dependency) to drop
  the transitive `uuid@10.0.0` pull that was the last live Dependabot alert
  (GHSA-w5hq-g745-h8pq). No production runtime change; `npm audit` now reports 0
  vulnerabilities. Integration suites re-verified: session-manager (308),
  admin-server (19), node-server (17).
