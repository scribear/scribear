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
step by hand. Two changes in this release are breaking (see _Breaking changes_
below); they are a minor bump rather than a major one because the project is
pre-1.0, where `1.0.0` is reserved for declaring the API stable.

### Optional: tell the Config Check what this deployment is

New in this release: **Admin → Config Check** reports the deployment's
configuration posture — placeholder secrets, missing login methods, a telemetry
backplane that nothing publishes to, containers that never came up.

Severity depends on what the deployment _is_: a placeholder password is
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

Every finding also carries the severity it _would_ have in production, so a
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

That is deliberate. Both new secrets fail _open_ rather than closed if left
blank, so the compose file refuses to interpolate them rather than let the
stack come up in that state:

- An empty `NODE_SERVER_SERVICE_KEY` makes the node server's internal service
  routes accept any caller that sends a bare `Authorization: Bearer ` header —
  the empty configured key matches the empty presented key.
- An empty `REDIS_PASSWORD` does not produce a locked-down Redis. `redis-server
--requirepass ""` is an _open_ server that accepts every unauthenticated
  command, and it would be holding the whole fleet's operational state.

The services enforce the same rule independently of Compose: node-server,
session-manager and transcription-service now refuse to boot on an empty or
`CHANGEME` key, so Kubernetes or hand-rolled `docker run` deployments fail
loudly too. The placeholder test matches `CHANGEME` as a substring, so the
example values that carry a length-rule suffix —
`CHANGEME-JWT-must-be-at-least-32-characters-long` and friends — are caught as
well. **If any secret in your `.env` still contains `CHANGEME`, that service
will now refuse to start.** That is the intended behaviour, but it will surface
on upgrade rather than at leisure, so check before you pull.

### Required `.env` additions

Two new keys, both mandatory. Everything else this release adds is optional and
defaulted — see _Complete `.env` delta_ below for the full picture. Generate a
distinct high-entropy value for each — for example `openssl rand -hex 32`.

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

| Service              | Image                | Notes                                                                                                                                                             |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis`              | `scribear-redis`     | Telemetry backplane. Not published to the host; `backend` network only. No persistence — every key is a short-TTL snapshot its publisher rewrites within seconds. |
| `monitoring-sidecar` | `monitoring-sidecar` | Black-box poller. No longer mounts the Docker socket — the log-ingestion path it needed that for was removed in B1.2.                                             |

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
when its key is blank, and a blank key is a _silent_ degradation — the sidecar
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

### Optional: automatic image updates (watchtower)

`watchtower` polls the registry and recreates any container whose tag now points
at a newer digest. It is in `compose.yml` behind the `autoupdate` profile, so it
does **not** start unless you ask for it:

```dotenv
COMPOSE_PROFILES=autoupdate
WATCHTOWER_POLL_INTERVAL=1800
```

Then `docker compose up -d` as usual — no `-f` flags.

On staging, where `IMAGE_TAG=staging` and every push republishes it, this is
what makes the box continuously deployed with nobody logging in. **Think before
production.** Recreating a container ends every WebSocket it was serving, so an
update to `node-server` or `transcription-service` drops the sessions they are
carrying — captions stop mid-sentence and the kiosk has to reconnect. It is also
unattended: with `IMAGE_TAG=latest`, a merge to `main` deploys itself, at
whatever hour it happens to land. Production generally wants a chosen moment.

It also mounts the Docker socket, which is root-equivalent on the host. The
monitoring sidecar gave up exactly that mount in B1.2; enabling this profile
puts one back, in a container whose job is to pull images and restart things.

`WATCHTOWER_SCOPE` is empty by default, which means watchtower updates **every
container on the host**, including any unrelated to ScribeAR. On a dedicated box
that is usually what you want. To narrow it, set a name and label the containers
to include:

```dotenv
WATCHTOWER_SCOPE=scribear
```

```yaml
# compose.override.yml — repeat per service you want auto-updated
services:
  node-server:
    labels:
      com.centurylinklabs.watchtower.scope: scribear
```

`WATCHTOWER_CLEANUP` is on unconditionally: without it the superseded image
layers are never reclaimed and a box polling every 30 minutes fills its disk.

### New optional tuning knobs

All defaulted; the stack behaves identically if you ignore them. See
[`.env.example`](.env.example) for the full annotated list — device presence
(`DEVICE_ONLINE_TTL_SEC`, `DEVICE_LAST_SEEN_WRITE_SEC`), the health-rollup
timeout (`ADMIN_HEALTH_TIMEOUT_SEC`), and the sidecar's poll intervals and alert
thresholds (`MONITORING_*`).

### Complete `.env` delta

Everything `compose.yml` reads that a pre-0.2.0 `.env` does not have. Only the
first two are required; the rest have working defaults and can be added when you
want the feature.

| Key                                                   | Needed?      | What it is for                                                                           |
| ----------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `NODE_SERVER_SERVICE_KEY`                             | **Required** | Inbound service auth on node-server. Stack will not start without it.                    |
| `REDIS_PASSWORD`                                      | **Required** | Telemetry backplane password. Stack will not start without it.                           |
| `DEPLOYMENT_ENV`                                      | Recommended  | Which standard the Config Check judges against. Unset infers `production`.               |
| `ADMIN_REDIS_URL`                                     | Optional     | Lets the admin console read the fleet view. Unset ⇒ `/fleet` answers 503.                |
| `NODE_SERVER_REDIS_URL`                               | Optional     | Lets node-server publish telemetry. Unset ⇒ absent from the dashboard.                   |
| `TRANSCRIPTION_REDIS_URL`                             | Optional     | Same, for transcription-service.                                                         |
| `TRANSCRIPTION_METRICS_KEY`                           | Optional     | Read-only key for `/metrics/status`. Unset ⇒ sidecar's transcription metrics stay empty. |
| `COMPOSE_PROFILES`                                    | Optional     | `autoupdate` switches on watchtower.                                                     |
| `WATCHTOWER_POLL_INTERVAL`, `WATCHTOWER_SCOPE`        | Optional     | Only read when that profile is on.                                                       |
| `ADMIN_HEALTH_TIMEOUT_SEC`                            | Optional     | Per-component timeout for the health rollup (default 3).                                 |
| `DEVICE_ONLINE_TTL_SEC`, `DEVICE_LAST_SEEN_WRITE_SEC` | Optional     | Device presence tuning (defaults 180 / 60).                                              |
| `MONITORING_*`                                        | Optional     | Sidecar poll intervals, alert thresholds, canary. All defaulted.                         |

Nothing was removed: every key a 0.1.x `.env` already had is still read. `ORIGIN`
is not referenced by `compose.yml` and never was — it is read by the helper
scripts in this directory (`create-room.sh`, `register-device.sh`,
`create-session.sh`), so keep it.

### Moving a host off a hand-edited `compose.yml`

If a deployment forked `compose.yml` to add something locally, it will not pick
up any of the above by pulling. Move it back onto the tracked file:

1. `diff` your host's `compose.yml` against the tracked one for the release you
   forked from — `git show <tag>:deployment/compose.yml` — so you know exactly
   what is local. It is usually less than it feels like.
2. Anything that is now upstream (watchtower is, as of this release) needs no
   action beyond the `.env` keys above.
3. Put whatever genuinely remains in `deployment/compose.override.yml`. Compose
   loads that automatically next to `compose.yml`, with no `-f` flags, and it is
   gitignored. Only the keys you restate are overridden.
4. Replace the host's `compose.yml` with the tracked one and `docker compose
config` to confirm the merged result before `up -d`.

The point is that the host stops carrying a fork that silently misses every
later change — which is how a deployment ends up several releases behind on
exactly the settings it most needs.

### `TRANSCRIPTION_DEVICE` gained a value

`cuda128` (CUDA 12.8 / cuDNN 9) joins `cpu` and `cuda` (CUDA 12.2 / cuDNN 8).
Blackwell (sm_120) and newer GPUs need `cuda128`. Existing `cpu` and `cuda`
values are unchanged.

### Rollback

Reverting `compose.yml` to the previous release is sufficient; the two new keys
are ignored by it. Nothing in this release migrates the database or rewrites
persistent state, and Redis holds nothing worth preserving.
