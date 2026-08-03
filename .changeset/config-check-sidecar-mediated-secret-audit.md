---
'@scribear/node-server-schema': minor
'@scribear/node-server': minor
'@scribear/monitoring-sidecar': minor
'@scribear/admin-server': minor
---

Config Check now reports on the four secrets admin-server deliberately never
holds, without being given any of them.

`JWT_SECRET`, `NODE_SERVER_KEY`, `NODE_SERVER_SERVICE_KEY` and
`TRANSCRIPTION_API_KEY` are invisible to admin-server by design, so a
deployment could sit on all four as `CHANGEME` placeholders with Config Check
entirely green. The obvious fix — hand admin-server copies so it can check them
— makes every deployment strictly less secure in order to report on its
security, and was rejected by the plan's own trust-boundary table.

Instead the service that already holds all four classifies its own copies.
node-server's `AppConfig` gains a `secretPlaceholders` getter applying the same
case-insensitive `CHANGEME` substring rule Config Check already uses, exposed
as four booleans on its existing authenticated `GET /status`
(`SECRET_PLACEHOLDERS_SCHEMA`). The monitoring sidecar already polls that
endpoint with `NODE_SERVER_SERVICE_API_KEY`, so it re-exposes the
classification on a new `GET /api/monitoring/v1/config-audit` —
unauthenticated and backend-network-only, the same trust boundary `/metrics`
and `/probes/readiness` already carry. admin-server reads that over the compose
network it already uses for the sidecar's build info and translates
node-server's env var names to the deployment `.env` names. Four booleans move;
no secret value does, and no service gains a credential it did not already
have. Verified live with `docker exec admin-server env`.

Why node-server rather than session-manager or transcription-service, which
also hold some of these: node-server is the only service that holds **all
four** and already has an authenticated status endpoint an observability
consumer polls. So this phase needed no change to either of those services, no
new env var anywhere, and no `COMPOSE_FILE_VERSION` bump.

**The new field is deliberately a sibling of `sessions`/`sessionsTruncated` on
the route response, not part of `STATUS_PROCESS_SCHEMA`.**
`NODE_SNAPSHOT_SCHEMA` spreads `STATUS_PROCESS_SCHEMA.properties`, so the
obvious placement would have silently published a secret classification into
the Redis fleet-telemetry namespace, admin-server's `FleetSnapshot` and the
fleet dashboard — three more copies to go stale, for data with exactly one
reader.

Also deliberately **not** a Prometheus metric. Routing it through `/metrics`
would gate these findings behind the optional `monitoring` compose profile;
Prometheus and Grafana are opt-in, and these four secrets are live in every
deployment. It is a classification, not a measurement.

**`unavailable` is a first-class answer, never silence.** `AbsoluteStatusPoller`
gains an `enabled` getter so `nodeServer.status` can distinguish "will never
poll" (`disabled` — the sidecar has no service key), "has not polled yet"
(`not-yet-polled`) and the existing `POLL_ERROR_REASONS` from a failed poll.
Config Check turns any of them into its own
`secret-placeholder-audit-unavailable` finding (warning; advisory in
development, matching the four secret findings), so a broken sidecar reads as
"cannot currently check" and never as a clean bill of health. Admin-server
validates the whole `/config-audit` body with `Value.Check` against a TypeBox
schema before dereferencing any field — the same thing
`NodeStatusPollerService._parseBody` does one hop upstream, so both ends of the
wire are validated alike. The schema stays open to unknown properties on
purpose, so a *newer* sidecar's extra fields still validate and upgrading the
sidecar first cannot blind Config Check.

**Known limitation, named in the finding's own remediation text:** a
placeholder `NODE_SERVER_SERVICE_KEY` can only ever surface as the generic
`secret-placeholder-audit-unavailable`, never as its own finding. That key
guards `/status` itself, and node-server's `ServiceAuthService` refuses to
construct while it contains `CHANGEME` — a deliberate pre-existing fail-closed
design — so the endpoint 500s before it can self-report on that specific key.
The deployment still never reads as clean; the operator gets "something is
wrong with node-server's status auth" rather than the variable's name. Not
worked around by giving a second service a way past node-server's boot check.
