# Upgrading a deployment

Version-to-version notes for operators running the Docker Compose stack in
[`compose.yml`](compose.yml). Newest first. For first-time setup, start at the
wiki [Deployment](https://github.com/scribear/scribear/wiki/Deployment) page
instead — this file only covers what changes between releases.

The stack reads its configuration from `deployment/.env`. That file is not
tracked, so it does not update when you pull; new required keys have to be added
by hand. [`.env.example`](.env.example) is the tracked reference and always
lists every key the current `compose.yml` understands.

---

## 0.2.0 — monitoring & fleet dashboard

Adds the admin fleet dashboard, the monitoring sidecar, a Redis telemetry
backplane, and the admin console's Config Check page.

Every image moves from `0.1.0` to `0.2.0` together — the npm packages are a
changesets `fixed` group, and `transcription_service/pyproject.toml` is kept in
step by hand. Two changes in this release are breaking (see *Breaking changes*
below); they are a minor bump rather than a major one because the project is
pre-1.0, where `1.0.0` is reserved for declaring the API stable.

### Optional: tell the Config Check what this deployment is

New in this release: **Admin → Config Check** reports the deployment's
configuration posture — placeholder secrets, missing login methods, a telemetry
backplane that nothing publishes to, containers that never came up.

Severity depends on what the deployment *is*: a placeholder password is
unremarkable on a laptop and a compromise in production. Set `DEPLOYMENT_ENV` so
the page judges against the right standard.

```dotenv
# development | staging | production
DEPLOYMENT_ENV=production
```

Leaving it unset infers `production` unless admin-server was started with
`--dev`. That is the deliberate direction: an existing deployment that never
sets it is judged strictly rather than reassured. The variable is reporting-only
— nothing behaves differently — and an unrecognized value is reported by the
check itself rather than blocking startup.

Every finding also carries the severity it *would* have in production, so a
staging deployment can be checked for promotion-readiness without changing
anything. The page never displays a secret value, only whether each is set and
how long it is.

### What breaks if you upgrade without reading this

`docker compose up` **fails immediately**, before any container starts, with:

```
error while interpolating services.node-server.environment.NODE_SERVER_SERVICE_API_KEY:
required variable NODE_SERVER_SERVICE_KEY is missing a value: NODE_SERVER_SERVICE_KEY is
unset. Your .env predates the monitoring/fleet release - read deployment/UPGRADING.md
(or the wiki Deployment page) and add the new keys before starting.
```

That is deliberate. Both new secrets fail *open* rather than closed if left
blank, so the compose file refuses to interpolate them rather than let the
stack come up in that state:

- An empty `NODE_SERVER_SERVICE_KEY` makes the node server's internal service
  routes accept any caller that sends a bare `Authorization: Bearer ` header —
  the empty configured key matches the empty presented key.
- An empty `REDIS_PASSWORD` does not produce a locked-down Redis. `redis-server
  --requirepass ""` is an *open* server that accepts every unauthenticated
  command, and it would be holding the whole fleet's operational state.

The services enforce the same rule independently of Compose: node-server and
session-manager now refuse to boot on an empty or `CHANGEME` service key, so
Kubernetes or hand-rolled `docker run` deployments fail loudly too.

### Required `.env` additions

Two new keys, both mandatory. Generate a distinct high-entropy value for each —
for example `openssl rand -hex 32`.

```dotenv
# Inbound service-to-service auth for the node server's internal observability
# routes (read by the monitoring sidecar). MUST be a different secret from
# NODE_SERVER_KEY, which the node server presents outbound to session-manager.
NODE_SERVER_SERVICE_KEY=<new secret>

# Password for the Redis telemetry backplane.
REDIS_PASSWORD=<new secret>
```

### New containers

Two services join the stack. Both are pulled from the same registry and tag as
everything else, and CI publishes them alongside the existing images, so no
registry or tag changes are needed.

| Service | Image | Notes |
| --- | --- | --- |
| `redis` | `scribear-redis` | Telemetry backplane. Not published to the host; `backend` network only. No persistence — every key is a short-TTL snapshot its publisher rewrites within seconds. |
| `monitoring-sidecar` | `monitoring-sidecar` | Black-box poller. No longer mounts the Docker socket — the log-ingestion path it needed that for was removed in B1.2. |

Nothing in the transcription path reads or writes Redis. Losing it costs the
dashboard its cross-instance view and costs live sessions nothing.

Plan for the extra resident memory of two more containers on the host. If you
pin images by digest rather than tag, add entries for both.

### Optional: turning telemetry on

Standing up Redis does **not** switch telemetry on. Every publisher and reader
is gated on its own `*_REDIS_URL`, all unset by default, so after the upgrade
the container runs and nothing talks to it. This is intentional: introducing
shared infrastructure in the same step that starts depending on it makes a
telemetry bug and a deployment bug look identical.

To populate the fleet view, set these to the same Redis using the password
above, then restart the affected services:

```dotenv
NODE_SERVER_REDIS_URL=redis://:<REDIS_PASSWORD>@redis:6379
TRANSCRIPTION_REDIS_URL=redis://:<REDIS_PASSWORD>@redis:6379
ADMIN_REDIS_URL=redis://:<REDIS_PASSWORD>@redis:6379
```

Leaving them unset is a supported steady state. With `ADMIN_REDIS_URL` unset,
`GET /api/admin/v1/fleet` answers `503 TELEMETRY_UNAVAILABLE`; the admin
console's top-bar health rollup is a separate, always-on data path and is
unaffected either way.

### Optional: monitoring sidecar metrics

The sidecar polls two authenticated endpoints. Each is independently disabled
when its key is blank, and a blank key is a *silent* degradation — the sidecar
runs, the affected metric series are simply empty. The log parsers that used to
infer these signals were retired when the endpoints landed, so there is no
fallback source.

```dotenv
# Read-only key for transcription-service's /metrics/status. Deliberately NOT
# TRANSCRIPTION_API_KEY: that one opens transcription sessions, this one only
# reads counters. Set it on BOTH sides or the poll 404s.
TRANSCRIPTION_METRICS_KEY=<new secret>
```

`NODE_SERVER_SERVICE_KEY` above already covers the node-server status poll.

The synthetic canary (`MONITORING_CANARY_DEVICE_TOKEN`) is off by default and
needs a one-time device registration. **It streams synthetic speech into a real
session**, so its device must belong to a dedicated canary room — pointing it at
a teaching room injects fixture audio into that lecture's live captions. Setup
steps are in [`../apps/monitoring-sidecar/.env.example`](../apps/monitoring-sidecar/.env.example).

### Breaking changes to existing behaviour

- **Docker log ingestion is gone.** Anything scraping the monitoring sidecar's
  log-derived metrics needs to move to the polled endpoints above.
- **The admin health rollup now covers every service**, so its response shape
  changed. Re-check any external consumer of `/api/admin/v1/health`.

### New optional tuning knobs

All defaulted; the stack behaves identically if you ignore them. See
[`.env.example`](.env.example) for the full annotated list — device presence
(`DEVICE_ONLINE_TTL_SEC`, `DEVICE_LAST_SEEN_WRITE_SEC`), the health-rollup
timeout (`ADMIN_HEALTH_TIMEOUT_SEC`), and the sidecar's poll intervals and alert
thresholds (`MONITORING_*`).

### `TRANSCRIPTION_DEVICE` gained a value

`cuda128` (CUDA 12.8 / cuDNN 9) joins `cpu` and `cuda` (CUDA 12.2 / cuDNN 8).
Blackwell (sm_120) and newer GPUs need `cuda128`. Existing `cpu` and `cuda`
values are unchanged.

### Rollback

Reverting `compose.yml` to the previous release is sufficient; the two new keys
are ignored by it. Nothing in this release migrates the database or rewrites
persistent state, and Redis holds nothing worth preserving.
