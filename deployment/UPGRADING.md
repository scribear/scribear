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

## Unreleased — Azure Entra ID SSO reaches admin-server (`compose.yml` v14)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. A
stock deployment needs to do nothing new — all five variables below default
to empty, identical to today's behavior (SSO off, local login only).

`admin-server`'s `AzureOidcAuthService` was implemented, but the five
`AZURE_*`/`ADMIN_ALLOWED_GROUP` variables it needs were never actually wired
into `compose.yml` — setting them in `.env` had no effect at all, since the
container never received them. Fixed:

- **`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_REDIRECT_URI`, `ADMIN_ALLOWED_GROUP`** now pass through to
  `admin-server`, matching `.env.example`. All five must be non-empty for
  the "Sign in with Illinois" button to appear — see
  [`.env.example`](.env.example) and `scribear.wiki/Developing Admin.md`
  "Azure Entra ID SSO provider" for the one-time Azure app-registration
  walkthrough and where each value comes from.

## Unreleased — per-device alert thresholds (automatic CPU/GPU selection)

The monitoring sidecar now selects the `asrDutyRatio` threshold per provider
based on the inference device the transcription service reports. A GPU
provider keeps the existing 0.45 default; a CPU provider gets 0.7 — the value
that was previously a manual `.env` override. **A stock CPU deployment no
longer needs `MONITORING_ASR_DUTY_RATIO=0.7`**: it is the default for CPU.

The transcription service reports `providerDevice` on `/metrics/status`
alongside `providerJobPeriodMs`, using the same reported-then-fallback shape.
A service too old to send it (a rolling upgrade) leaves the field absent, and
the sidecar falls back to the GPU default — the existing behaviour.

The flat override `MONITORING_ASR_DUTY_RATIO` still wins over both per-device
defaults, preserving the escape hatch for a deployment that needs its own
number.

A new env var `MONITORING_ASR_DUTY_RATIO_CPU` (default 0.7) lets an operator
tune the CPU default without affecting GPU providers. `MONITORING_ASR_DUTY_RATIO`
remains the flat override.

## Unreleased — CPU default model is now `base`; `transcription-service-cpu` publishes multi-arch

The shipped CPU provider template now defaults to whisper **`base`** instead
of `small`. `base` has comfortable headroom on CPU (mean RTF 0.17 vs 0.47 for
`small` at the same `cpu_threads`), making the out-of-box CPU experience
reliable on a wider range of hardware. `small` remains a one-line config edit
for hosts that can afford it — see
[Transcription on CPU-Only Hardware](https://github.com/scribear/scribear/wiki/Transcription-on-CPU-Only-Hardware)
for the measured tradeoffs.

This affects `provider_config.template.json` only. An existing deployment's
`provider_config.json` is a copy and is not overwritten; edit it by hand to
change the model. Models download automatically on first use via the `/models`
bind mount (`HF_HOME=/models/hf`), so switching is a config edit and a restart,
not a manual download.

`transcription-service-cpu` is now published as a multi-arch manifest
(`linux/amd64` + `linux/arm64`) alongside the Node and infra images. A Mac
pulling `transcription-service-cpu:staging` gets a native arm64 image with no
emulation. The two CUDA variants remain amd64-only — they cannot run on a Mac.

## Unreleased — onsite-only access gate (`compose.yml` v13)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. A
stock deployment needs to do nothing new — the two variables below default to
"nobody is restricted," identical to today's behavior.

`nginx.conf` can now restrict every route — every API (403) and every
frontend (redirected to a landing page) — to an explicit allowlist of source
IP ranges, instead of being reachable from anywhere on the internet:

- **`ONSITE_ALLOWLIST_PATH`** (default `./onsite/allowlist.default.conf`, a
  permissive "everyone is onsite" file checked into this directory) — point
  this at a real allowlist (see
  [`onsite-allowlist.example.conf`](onsite-allowlist.example.conf), built for
  University of Illinois Urbana-Champaign's own published ranges, as a
  starting point for another campus/network) to actually restrict access.
  Unlike `PROVIDER_CONFIG_PATH`, this default is a real, live file, not a
  `.template` to copy first — "nobody is restricted" is a sane universal
  default here, so a deployment that never touches this variable is simply
  never gated.
- **`ONSITE_CONTENT_PATH`** (default `./onsite/content-default`) — the static
  landing page shown to a gated frontend request, explaining that live
  captions require an on-campus or VPN connection. Point this at your own
  directory to customize the wording or add branding.
- **`/extlanding`** is a new route, deliberately **never** gated. It serves
  the exact same landing page a gated visitor would see, reachable from
  anywhere — including from on campus — so whoever maintains
  `ONSITE_CONTENT_PATH` can preview what an off-campus visitor sees without
  spoofing their own IP address. Every gated frontend route redirects here.

**Prerequisite if you set `ONSITE_ALLOWLIST_PATH` to a real allowlist: nginx
must be the actual internet-facing edge.** The gate trusts `$remote_addr`
directly. If a load balancer, CDN, or any other proxy sits in front of this
nginx, every request arrives looking like it came from that proxy, not the
real client — and if the proxy's own address happens to fall inside your
allowlist (plausible if it runs on-campus), **every off-campus request
passes the gate**, silently. This is a fail-*open* failure, the opposite of
the gate's purpose, and it produces no error to notice. If that's your
topology, configure `set_real_ip_from`/`real_ip_header` in `nginx.conf`
first (commented-out guidance is right next to the `$onsite` allowlist
include) — don't turn on a real allowlist without doing this first.

Design and the full campus-network research behind the default allowlist:
`2026-08-02-PLAN-AccessRulesLandingPage.md` (not tracked in this repo). Code
review: `2026-08-02-REVIEW-AccessRulesLandingPage.md` (same location).

## Unreleased — db-backup hardening: retry, integrity check, opt-out, encryption (`compose.yml` v12)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. A
stock deployment needs to do nothing new — every variable below defaults to
today's behavior.

A round of hardening on the backup service from v10/v11, from a code review
after it shipped:

- **Failed off-host pushes now retry.** Previously, a push that failed (the
  offsite host down, say) was never retried — the next cycle pushed only its
  own fresh dump, silently leaving the failed one un-pushed forever until
  local retention pruned it. Each cycle now retries every not-yet-pushed dump
  first, so a sustained outage closes the gap entirely once the offsite host
  is reachable again, rather than leaving a permanent hole in the off-host
  history.
- **Every dump is integrity-checked before being kept.** `pg_dump` can exit 0
  on an archive nothing can actually read back (catalog corruption, OOM
  mid-dump). `pg_restore -l` now runs against every dump immediately, and a
  dump that fails it is discarded rather than kept and pushed.
- **`pg_dumpall --globals-only` runs alongside the main dump.** `pg_dump`
  never covered roles; this closes that gap. Small and fast next to the main
  dump, so it's not worth its own schedule.
- **`BACKUP_ENABLED`** (default `true`) — set to `false` for a deployment on
  managed Postgres (RDS and similar) that already has its own backups.
  db-backup idles instead of dumping, and Deployment Check reports the choice
  explicitly instead of "no backup found" forever.
- **`BACKUP_ENCRYPTION_KEY`** (empty/off by default) — optional GPG AES256
  encryption for every dump, at rest and in the offsite copy. Without it,
  dumps are compressed but not encrypted — readable by anyone with
  filesystem access to either host. db-restore needs the same value to read
  an encrypted dump back.
- **`start_period` on db-backup's healthcheck is now 30 minutes**, up from 2.
  `pg_dump` is single-threaded, so a multi-GB database's first dump can
  easily outrun a 2-minute grace period, which read an in-progress backup as
  a failed container.
- The `db-restore` comment claiming `--clean --if-exists` "overwrites" the
  target database was wrong: it drops and recreates only what the dump
  itself contains, not the whole database. Corrected; see the comment above
  that service for what that means for a forward-migrated target.

**Not changed, and worth knowing:** this remains a periodic logical backup
(`pg_dump`), not continuous WAL archiving — the recovery point is up to
`BACKUP_INTERVAL_SECONDS` old, by design, not an emergent property of a
tuning knob. If that gap is too wide for your data, the alternative is a
PITR tool (pgBackRest, Barman), not a shorter interval — `pg_dump`'s cost
scales with database size. Also unchanged: the first connection to a new
`BACKUP_OFFSITE_HOST` trusts its host key on faith
(`StrictHostKeyChecking=accept-new`); pre-populate `known_hosts` yourself if
that is not acceptable for your threat model.

---

## Unreleased — Deployment Check reports on Postgres backups (`compose.yml` v11)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. A
stock deployment needs to do nothing new — this only wires up reporting on
the `db-backup` service from v10, above; no new required variable.

`admin-server` gains a read-only bind mount of `db-backup`'s output directory
and reads `BACKUP_OFFSITE_METHOD`/`BACKUP_INTERVAL_SECONDS` directly. `db-backup`
has no HTTP surface for Config Check to probe the way every other dependency
on that page is probed — it is a cron loop, not a service — so the shared
bind mount is the only channel between the two containers. Deployment Check's
**Config Check** now reports, under a new `backups` category:

- **`backup-offsite-not-configured`** (advisory in development/staging,
  warning in production) — `BACKUP_OFFSITE_METHOD` is still `none`, so
  backups do not survive losing this host.
- **`backup-none-found`** (advisory/warning/warning) — no `.dump` file has
  landed yet. Expected for a short time after first bringing the stack up;
  otherwise check `docker compose logs db-backup`.
- **`backup-stale`** (warning in development, critical in staging/production)
  — the newest backup is older than `BACKUP_INTERVAL_SECONDS` plus an hour of
  grace, the same threshold `infra/scribear-db/backup-healthcheck.sh` uses, so
  this finding and that container's `docker compose ps` health status agree.

---

## Unreleased — periodic Postgres backups ship with the stack (`compose.yml` v10)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. Unlike
most entries below, a stock deployment is not a no-op here: a new `db-backup`
service starts `pg_dump`ing `DB_NAME` every four hours and keeping 14 days of
it under `./db-backups` (next to this file), from the moment you bring the new
file up. Nothing else changes — no new required variable, no `:?`-guard.

There is no external host script or crontab to set up. `db-backup` runs
straight off the `scribear-db` image over the `backend` network with the same
`DB_HOST`/`DB_USER`/`DB_PASSWORD` every other service already uses — no
`docker exec`, no Docker socket. That was a deliberate choice over the more
familiar shape (a cron entry on the host, `docker exec db pg_dumpall`): a host
script has to be remembered and kept in sync on every box separately — the
exact failure mode `run-migrator.sh` used to have, see `db-migrate` above —
where anything in `compose.yml` reaches every environment the same way a
`docker compose pull` already does.

It reuses the `scribear-db` image rather than a generic Postgres client image
so `pg_dump`'s version can never drift from the server it's backing up, and it
does **not** use the `pg_cron` extension already loaded into that same image —
`pg_cron` schedules SQL run *by* Postgres; it has no way to shell out to the
external `pg_dump` client, which is what actually walks the catalogs to
produce a dump.

Six variables, all optional, tune it — see
[`.env.example`](.env.example#L69) for the full set with defaults:

| `.env` key | Default | What it does |
| --- | --- | --- |
| `BACKUP_INTERVAL_SECONDS` | `14400` (4h) | How often to dump |
| `BACKUP_RETENTION_DAYS` | `14` | How long to keep local copies |
| `BACKUP_OUTPUT_PATH` | `./db-backups` | Where dumps land on the host |
| `BACKUP_OFFSITE_METHOD` | `none` | `none`, `scp`, or `rsync` — push each dump off this host too |
| `BACKUP_OFFSITE_HOST` / `_PORT` / `_USER` / `_PATH` | *(empty)* | Where to push it, when the above is not `none` |
| `BACKUP_SSH_KEY_PATH` | `./db-backup-ssh-key` | Private key for the offsite account |

**Local retention alone does not survive losing this host** — it shares a disk
with `postgres_data`. Set `BACKUP_OFFSITE_METHOD` to `scp` or `rsync` (the
latter needs the `rsync` binary on the *receiving* host too) to also copy each
dump somewhere else — another box you control, or anywhere else reachable over
SSH. `db-backup`'s own healthcheck reports unhealthy in `docker compose ps` if
no backup has landed in `BACKUP_OUTPUT_PATH` within one interval plus an hour
of grace, so a stuck or misconfigured push shows up rather than failing
silently.

A profile-gated `db-restore` service ships alongside it —
`RESTORE_FILE=<name>.dump docker compose --profile restore run --rm
db-restore` — for restore drills and the real thing. It is not started by
`up -d`; run it once against a scratch database (a separate `DB_NAME`, or a
`compose.override.yml` pointed at a throwaway Postgres) to find out the
restore path actually works before the day it has to. `pg_restore --clean
--if-exists` **overwrites** whatever is already in the target database.

---

## Unreleased — the capacity estimator's knobs are reachable from `.env` (`compose.yml` v9)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. **A
stock deployment needs to do nothing** — all three new variables carry the
values the service already used.

Three new variables on `transcription-service`, all optional:

| `.env` key | Default | What it does |
| --- | --- | --- |
| `TRANSCRIPTION_TARGET_BUSY` | `0.85` | Fraction of a worker the estimated ceiling aims to keep busy |
| `TRANSCRIPTION_MIN_SESSIONS` | `1` | Floor under the estimated ceiling, so one bad window cannot report zero |
| `TRANSCRIPTION_MAX_SESSIONS` | *(empty)* | Operator hard pin. Empty means auto-tune |

transcription-service measures how much of a worker one ASR session actually
costs and derives a ceiling — `estimatedCapacitySessions` on
`/metrics/status` and `/providers/health`, drawn as "estimated capacity" in the
dashboard's fleet view. **It is observe-only: nothing is refused because of it**,
so these three change what is *reported*, never who gets captions.

`TRANSCRIPTION_MAX_SESSIONS` is the strongest of the three on purpose. It wins
over `TRANSCRIPTION_MIN_SESSIONS` *and* over warm-up, so it applies from the
first request rather than after a measurement it has already overruled — it is a
statement about your hardware, not an estimate. Set it if you have measured your
box and want the dashboard to say so; leave it empty otherwise.

### Why this is an upgrade note at all

The service has read `TARGET_BUSY`, `MIN_SESSIONS` and `MAX_SESSIONS` from its
environment since they were added, and its own config file says they are
"reachable from `.env` on purpose". They were not: nothing passed them through
`compose.yml`, so a compose operator had no way to set them short of editing the
compose file — which is exactly the regret that variable was created to avoid,
one indirection along. This closes it.

Empty is read as "unset" for `TRANSCRIPTION_MAX_SESSIONS`, because compose has
no way to omit an environment key. A value that is neither empty nor a number
still stops the service at boot, deliberately: silently auto-tuning under a
`MAX_SESSIONS` an operator believed was a hard pin is a misconfiguration with no
symptom to find.

---

## Unreleased — node-server is sticky-routed by session uid

**Pull the new `scribear-nginx` image** (`docker compose pull scribear-nginx &&
docker compose up -d`, or just run [`deploy_latest.sh`](deploy_latest.sh)). No
`.env` or `compose.yml` change; the fix is inside the image.

`upstream node-server` in `nginx.conf` now carries
`hash $node_server_session_uid;`, keyed off the session uid in the WebSocket
URL path. Before this, it had no balancing directive at all — nginx
round-robined.

That was survivable only because the service runs one replica.
`docker compose up -d --scale node-server=2` would have broken live captioning
in a way nothing reports: node-server's orchestrator state is per-process (the
event bus, the upstream transcription socket), so a viewer routed to a
different instance than its room's source subscribes to a channel nothing
publishes on and receives no transcripts — no error, no close, no banner, just
an empty caption view. **Scaling node-server past one replica is now
supported**; before, it was not, and nothing said so.

One caveat worth knowing before you scale: the hash is a plain modulo, not
ketama. `consistent` is silently ignored by this nginx when the upstream server
is a `resolve` name (measured — it falls back to round-robin, `nginx -t` passes
either way), so it is deliberately not used. The practical consequence is that
changing the replica count re-homes most sessions; do it when a brief
reconnect is acceptable.

---

## Unreleased — session-manager validates `transcriptionProviderId` (`compose.yml` v8)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`.

New variable: **`TRANSCRIPTION_PROVIDER_IDS`** on `session-manager`. It is a
comma-separated list of the provider keys session-manager will accept when a
session, schedule or auto-session window is created or updated, and it defaults
to the set shipped in `provider_config.template.json`
(`debug,whisper,lumen_granite,crisper_whisper`). **A stock deployment needs to
do nothing.**

**If you have edited `provider_config.json`** — added a provider, removed one,
renamed a key — set `TRANSCRIPTION_PROVIDER_IDS` in `.env` to exactly the keys
under its `"providers"` object. The two files now have to agree, and this is the
one place that says so.

### Why

A `transcriptionProviderId` naming no configured provider used to be accepted
silently and only fail when someone tried to use the room: transcription-service
raises `Invalid Provider Key` and closes the socket with 1007, node-server
retries a request that can never succeed, and every viewer sits on
"Connection to the transcription service was lost. Reconnecting…" forever, with
nothing anywhere naming the cause. The typo is made once, by an operator, at a
keyboard — it is now answered there, with a `400` that lists the accepted keys.

The list is deployment configuration rather than a fixed set in the API schema
because `provider_config.json` is yours to edit: a hardcoded set would reject a
provider you legitimately added and accept one you removed. It is not read live
from transcription-service either — that endpoint needs `METRICS_API_KEY`, a
credential session-manager does not have, and it would make scheduling fail
whenever transcription-service is down.

Getting the list wrong is loud either way: too narrow and a create fails
immediately with the accepted keys in the message; too wide and you are back to
the old behaviour, which the viewer now sees as a specific "misconfigured"
message rather than an endless reconnect.

---

## Unreleased — watchtower is gone; `deploy_latest.sh` replaces it (`compose.yml` v7)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. If
`.env` has `COMPOSE_PROFILES=autoupdate`, `WATCHTOWER_POLL_INTERVAL` or
`WATCHTOWER_SCOPE`, remove them — they are no longer read (leave `monitoring`
in `COMPOSE_PROFILES` if you use it; only `autoupdate` is gone). No service
depended on watchtower, so this is otherwise a no-op until you set up its
replacement below.

### Why it's gone

Watchtower updates containers **one at a time**, the moment it notices a new
digest for each — independently of everything `compose.yml`'s `depends_on`
exists to enforce. Concretely, that meant:

- It has no idea `db-migrate` exists. `session-manager` or `admin-server`
  could get recreated against a new image whose schema migration never ran,
  because watchtower only manages long-running containers, and the migration
  is deliberately a one-shot job.
- It recreates services in whatever order it happens to poll them, not the
  order `depends_on`/`service_healthy` would choose. Two services meant to
  ship together can sit version-skewed for a full poll interval.
- Nothing tells `nginx` afterward. Its `upstream` blocks used to resolve a
  backend container's hostname once, at nginx's own startup; when watchtower
  recreated that container it got a new address on the docker network, and
  nginx kept talking to the old one — possibly since reused by an unrelated
  container — until something restarted it too. (`nginx.conf`'s upstreams now
  resolve dynamically regardless, via `resolve`/`zone`, so this specific
  failure mode is fixed independently of watchtower's removal — but the new
  `scribear-nginx` image has to actually be pulled for that fix to take
  effect; see the note below.)
- It runs with the Docker socket mounted, permanently, for a background poll
  loop — root-equivalent on the host, which is exactly what the monitoring
  sidecar gave up in B1.2.

None of that is a corner case: it is a full outage or a wrong-service response
waiting for the poll interval to trigger it.

### What replaces it

[`deploy_latest.sh`](deploy_latest.sh) does the same three things an operator
already had to do by hand — fetch the compose file this branch/tag tracks,
`docker compose pull`, `docker compose up -d` — as one script meant to run on
a timer instead of a long-lived container. Unlike watchtower, that third step
*is* `docker compose up -d`, so it runs `db-migrate` and waits on
`depends_on`/`service_healthy` exactly as a manual upgrade would. It also
reloads `nginx` afterward, but that step is a belt-and-suspenders nicety now,
not the fix: `nginx.conf`'s upstreams resolve backend addresses dynamically
(`resolve`/`zone`) as of this release, so nginx self-corrects within a few
seconds of any backend `up -d` recreates with no action needed at all — the
reload just makes that immediate instead of waiting out the resolver's TTL.

**That dynamic-resolver fix lives in the `scribear-nginx` image itself**, not
in `compose.yml` or `.env` — an operator who pulls selectively (e.g.
`docker compose pull session-manager admin-server`, skipping the rest) would
miss it. `docker compose pull` with no arguments, which is what
`deploy_latest.sh` runs, already covers it.

Sample [systemd unit/timer](deploy/scribear-deploy@.service) and
[crontab entry](deploy/crontab.sample) are in `deployment/deploy/` — pick
whichever this host already uses, point `WorkingDirectory` (systemd) or the
`cd` (cron) at wherever this deployment's `.env` lives, and enable it. Both run
`deploy_latest.sh` at the same interval watchtower polled at
(`WATCHTOWER_POLL_INTERVAL` defaulted to 1800s), so if you were relying on that
cadence nothing needs to change but the mechanism.

The WebSocket-dropping caveat that applied to watchtower applies here too, by
nature of `docker compose up -d` recreating whatever changed — this script
does not make that free, it makes it the same `up -d` you would have run
anyway, on a schedule. Production still wants that schedule chosen
deliberately rather than left at "every 30 minutes."

## Unreleased — Config Check probes the monitoring profile (`compose.yml` v6)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d` to
pick up two new admin-server environment variables:
`ADMIN_GRAFANA_BASE_URL` and `ADMIN_PROMETHEUS_BASE_URL`. Both are empty by
default, so nothing breaks if you delay.

### What it adds

Admin → Config Check now reports whether the `monitoring` profile (see the
entry below), once turned on, is actually working — Prometheus reachable and
scraping the fleet sidecar, and Grafana reachable with its admin password no
longer the `CHANGEME` default. Leaving `monitoring` off is itself reported: a
warning in staging/production nudging you to turn it on (advisory in
development).

To wire it up once you have the `monitoring` profile on, add to `.env` (see
`.env.example`):

```dotenv
ADMIN_GRAFANA_BASE_URL=http://grafana:3000
ADMIN_PROMETHEUS_BASE_URL=http://prometheus:9090
```

## Unreleased — opt-in Prometheus + Grafana dashboard

No `compose.yml` version bump: two new services gated entirely behind the
`monitoring` profile, so a stack that never sets `COMPOSE_PROFILES=monitoring`
recreates no existing container.

**No action needed unless you want it.** Purely additive: a new `monitoring`
compose profile, off by default, same mechanism `autoupdate` already uses.
`docker compose up -d` with no `COMPOSE_PROFILES` set starts exactly the same
containers it did before this release.

### What it adds

Two new services, both gated behind `COMPOSE_PROFILES=monitoring`:
Prometheus (scrapes `monitoring-sidecar:80/metrics`, the fleet's own
aggregated Prometheus endpoint — nothing else, no new secrets) and Grafana
(auto-provisioned datasource and a seed fleet-overview dashboard, zero manual
UI configuration). See [`deployment/monitoring/README.md`](monitoring/README.md)
for how to turn it on and reach it, and
`archived-plans/2026-07-28-01-PLAN-Grafana-Monitoring.md` (outside this repo,
in `~/scribear2/`) for the design rationale.

To opt in, add four keys to `.env` (see `.env.example`):

```dotenv
COMPOSE_PROFILES=monitoring
GRAFANA_BIND=127.0.0.1
GRAFANA_PORT=3000
GRAFANA_ADMIN_PASSWORD=<a real password, not CHANGEME>
PROMETHEUS_RETENTION=15d
```

then `docker compose --profile monitoring up -d`. Prometheus is never
host-published; Grafana defaults to loopback-only — reach it with
`ssh -L 3000:localhost:3000 <host>`, or set `GRAFANA_BIND=0.0.0.0` yourself to
open it to the LAN.

To turn monitoring back off without touching the rest of the stack, use
`docker compose stop prometheus grafana && docker compose rm -f prometheus
grafana` — **not** `docker compose --profile monitoring down`, which tears
down the entire stack (`down` is not scoped by `--profile` the way `up` is).

## Unreleased — the last three T1 alert thresholds are now tunable (`compose.yml` v5)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. Nothing
breaks if you delay — these three thresholds simply keep whatever value was
compiled in, same as before this release.

### Why it changed

`ALERT_RTF_P95`, `ALERT_ASR_DUTY_RATIO_MIN_JOBS` and `ALERT_ASR_TAIL_P99_RTF` had
no `MONITORING_*` equivalent in `compose.yml`, unlike every neighbouring
threshold. Tuning any of them meant hand-editing `compose.yml` — exactly what
operators are told not to fork (see _Moving a host off a hand-edited
`compose.yml`_ below). They are now plumbed the same way as their neighbours:

```dotenv
MONITORING_RTF_P95=
MONITORING_ASR_DUTY_RATIO_MIN_JOBS=
MONITORING_ASR_TAIL_P99_RTF=
```

Empty (the default) means "use the sidecar's compiled default" — 2.0, 20 and 3.0
respectively — exactly like `MONITORING_ASR_DUTY_RATIO` and its two siblings
already worked. A CPU deployment tuning transcription saturation will most often
want `MONITORING_ASR_DUTY_RATIO` alongside these; see the wiki's "Transcription
on CPU-Only Hardware" page for measured values (e.g. `MONITORING_ASR_DUTY_RATIO=0.7`
for a CPU stack) — that variable is unchanged by this release, called out here
only because these thresholds are tuned together.

### A schema default was silently overriding the documented one

While wiring `ALERT_RTF_P95` through, the sidecar's config schema turned out to
default it to `1.0` even though `DEFAULT_THRESHOLDS.rtfP95` (and `.env.example`)
already said `2.0` — measured healthy GPU operation put p95 RTF at 0.96-1.28, so
`1.0` fires this CRITICAL on a healthy stack. Any deployment that left
`ALERT_RTF_P95` unset was silently getting the wrong default. It now uses the
same empty-string-means-default form as its neighbours, so the compiled default
in `alert-rules.ts` is the only place the number lives. If your `.env` sets
`ALERT_RTF_P95` explicitly, nothing changes for you; if it does not, you were
getting `1.0` before this release and get the documented `2.0` after.

---

## Unreleased — the monitoring canary is seeded, not provisioned (`compose.yml` v4)

**Action required only if you run the synthetic canary.**
`MONITORING_CANARY_DEVICE_TOKEN` is gone. If your `.env` sets it, **delete that
line** and set `MONITORING_CANARY_DEVICE_SECRET` to any value you like instead:

```dotenv
# Delete this line:
# MONITORING_CANARY_DEVICE_TOKEN=<uid>:<secret>

# Add this one. Any value; it is never transmitted anywhere.
MONITORING_CANARY_DEVICE_SECRET=<a long random string>
```

Then copy the new [`compose.yml`](compose.yml) and `docker compose up -d`. If
you never ran the canary, there is nothing to do — it stays off, and nothing is
seeded.

### What changed

The canary authenticated as a device an operator provisioned **by hand**:
register a device through the admin API, activate it, scrape `DEVICE_TOKEN` out
of a `Set-Cookie` header, paste it into `.env`, then create a room, attach the
device, mark it the source and give the room a standing schedule. Seven steps,
one of which — which room the device went into — decided whether fixture speech
could reach a live lecture.

Now the Session Manager seeds the room (`MONITORING-CANARY`), its source device
and one standing open-ended session, all under reserved uids, on every boot; and
the monitoring sidecar derives the token it presents from the same secret and the
same uid. Nothing is copied, pasted or transmitted between the two. This is the
same scheme `TEST_AUDIO_DEVICE_SECRET` already uses for the operator test-audio
devices, applied to the last hand-provisioned credential in the fleet.

### Why a second secret rather than reusing `TEST_AUDIO_DEVICE_SECRET`

They gate different features and would otherwise be tied together: setting one
value to arm the operator test devices would also start an unattended canary
probe every few minutes, and unsetting it to retire them would silently stop
monitoring. It would also hand a third service the root key every synthetic
device's credential is derived from. One extra line in `.env` is the cheaper
side of that trade.

### The room assignment is enforced now, not just documented

The canary streams a fixture recording into whatever session is active in its
room, **unattended**, every `MONITORING_CANARY_INTERVAL_SEC`. It is the only
synthetic source in the stack that runs with nobody watching, so a wrong room
would not be noticed until somebody read a transcript.

A device token reaches only its own device's room — the canary has no way to name
another — so that assignment is the entire safety boundary. Making it **in code**
is stronger than making it by hand: the room is seeded under a reserved uid no
other room can hold, there is no `Set-Cookie` header to misread, a re-run repairs
a drifted assignment rather than adding a second one, and room-management now
**refuses** to move the device into another room (409
`CANARY_DEVICE_NOT_ASSIGNABLE`) or to hand the canary room a different source
device (409 `CANARY_ROOM_NOT_ASSIGNABLE`).

### Retiring or rotating it

- **Rotate:** change `MONITORING_CANARY_DEVICE_SECRET` and restart the stack. The
  stored hash is re-written from the current value on every Session Manager boot.
- **Retire:** unset it, restart, **then** delete the room and the device in the
  admin console. Unsetting alone stops the seeder rewriting the hash but does not
  erase it, and while a device exists with a hash its derived token remains
  usable. That ordering matters, and it is the same one the test-audio devices
  use.

### Your old canary device is still there

Deleting `MONITORING_CANARY_DEVICE_TOKEN` does not delete the device it named.
That device and its hand-made room are now unused; delete both in the admin
console once the seeded canary is reporting.

### No separate `COMPOSE_FILE_VERSION` bump

Removing a variable and adding one would ordinarily earn a bump. It does not get
one here: `compose.yml` v4 is still unreleased, so no operator has ever held a v4
file. The change rides along in v4.

---

## Unreleased — transcription-service model downloads are now cached on a bind mount (`compose.yml` v4)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. Deployment
Check will report `old file` until you do. Nothing breaks if you delay: the
service still runs, it just re-downloads model weights on every container
recreation as before.

### What changed

`transcription-service` downloads faster-whisper and silero-vad weights at
runtime into `/root/.cache` inside the container, which a `docker compose up -d`
discards. The service now sets `HF_HOME: /models/hf` and bind-mounts a host
directory there, so weights are fetched once and reused. Both `huggingface_hub`
and `torch.hub` (silero-vad) honour `HF_HOME`, so the one variable covers both.

The host path is `MODEL_DOWNLOAD_PATH`, defaulting to `./models` relative to
`compose.yml`; it is created automatically on first download. A deployment that
already has weights downloaded can point `MODEL_DOWNLOAD_PATH` at that directory
to skip the initial download.

### No separate `COMPOSE_FILE_VERSION` bump

This adds a volume and an environment variable, which on its own would earn a
bump. It does not get one: `compose.yml` v4 is still unreleased, so no operator
has ever held a v4 file, and a v5 would only mean "copy the file you have not
copied yet". The change rides along in v4 — copying that one file picks up both
this and the test-audio services below.

---

## Unreleased — operator test-audio devices (`compose.yml` v4)

**No action required.** One new service and a handful of new optional
variables. Copy the new `compose.yml`; nothing starts or changes until you opt
in by setting two of them.

### What it is

Two synthetic source devices an operator drives from the admin console
(**Admin → Test Audio**):

- **`good`** — clean speech at an adjustable level and noise floor. `gainDb`
  spans −40 dB (below the ingress meter's silence floor) to +20 dB (hard
  clipping); both ends are reachable on purpose.
- **`fault`** — one knob per audio fault the stack claims to report — clipping,
  stutter, drops, faster-than-realtime, silence, DC bias, CRC corruption, a
  wrong-rate WAV header, clock skew — all independently settable and all
  defaulting to zero.

The point is to see what an alert looks like *before* it matters, and to check
that the thing the dashboard claims to detect is the thing it actually detects.
A retune applies to a running device without restarting the stream, so you turn
a knob and watch a meter move.

### ⚠️ Read this before turning it on

These devices stream synthetic speech into whatever session is active in their
room. Each has its **own dedicated test room** — `TEST-AUDIO-GOOD` and
`TEST-AUDIO-FAULT`.

A device token reaches **only its own device's room** — neither device has any
way to name another — so the device-to-room assignment is the *entire* safety
boundary, the same one the monitoring canary relies on. Putting one of these
devices in a teaching room would inject fixture speech into that lecture's live
captions, **silently**, with nothing in the stack to notice it.

That assignment is now made **in code**, and that is stronger than making it by
hand, not weaker. The Session Manager seeds both rooms and both devices under
reserved uids no other room or device can ever hold; there is no argument to
point at the wrong room and no prompt to misanswer at 2am; and room-management
**refuses** afterwards to move either device into another room (409
`TEST_AUDIO_DEVICE_NOT_ASSIGNABLE`) or to give either test room a different
source device (409 `TEST_AUDIO_ROOM_NOT_ASSIGNABLE`).

**Two rooms, not one:** a room has exactly one source device, and both devices
must be able to run at once.

### Turning it on

**There is no provisioning script and nothing to copy.** Two lines in
`deployment/.env`:

```sh
# admin-server -> generator, inbound. REQUIRED: the generator REFUSES TO START on
# an empty or CHANGEME value, because an empty inbound key matches the empty
# credential an unauthenticated caller presents as `Authorization: Bearer `.
TEST_AUDIO_SERVICE_KEY=<a strong secret>

# session-manager <-> generator. A DIFFERENT secret from the one above. Empty
# seeds nothing and leaves both devices disabled.
TEST_AUDIO_DEVICE_SECRET=<another strong secret>
```

```bash
cd deployment
docker compose --env-file .env -f compose.yml up -d
```

On its next boot the Session Manager creates, idempotently and at fixed uids:
the two rooms, one source device in each, each device's stored credential
(`bcrypt` of an HMAC of its uid under the secret), and **one standing,
open-ended session per room** — which is what the devices attach to, so nothing
has to be scheduled and `./create-session.sh` is not part of this any more. The
generator derives the very same credential from the same secret and the same
uids, so no token is ever transmitted, printed or pasted.

`TEST_AUDIO_BASE_URL` needs no entry — `compose.yml` defaults it to the in-stack
generator.

**Rotating the secret** is a change to that one line plus a restart: the stored
hash is re-written from the current value on every Session Manager boot, so both
sides move together.

**If a test room ever goes quiet** — someone ended its standing session from the
console — restarting the Session Manager re-opens it.

### Bounds

Every run **auto-stops at the duration it was started with**, unconditionally —
a timer is armed before any I/O and the send loop checks the same deadline every
chunk. `TEST_AUDIO_MAX_DURATION_SEC` (default 1800) caps what may be asked for
and is the authoritative limit; admin-server rejects only absurd values, so
lowering this is obeyed rather than contradicted. A forgotten device cannot
stream overnight, and the auto-stop survives admin-server going away.

Every mutation is audited by admin-server with the knob that was turned, at what
setting, for how long.

### The generator starts with the stack

It is not behind a compose profile. **Set `TEST_AUDIO_SERVICE_KEY` before your
next `up`**, or that one container will exit on every start with a message
naming the variable — the rest of the stack is unaffected, since nothing depends
on it.

Until `TEST_AUDIO_DEVICE_SECRET` is set the generator is **inert**: both devices
report `configured: false` and refuse to start, so the admin panel is visible
with every control disabled, and the Session Manager seeds nothing at all.
Setting the secret is the step that arms it, which is why the safety note above
sits next to it.

### Turning it off

Blank `TEST_AUDIO_BASE_URL` to hide the admin panel. To retire the devices
entirely: unset `TEST_AUDIO_DEVICE_SECRET`, restart, **then** delete the two
rooms and their devices in the admin console — while a device exists with a
stored credential, a token derived from the old secret remains usable. Unsetting
the secret alone stops the seeder re-writing the hash; it does not erase it.

---

## Unreleased — the transcription CRITICAL now reads dropped periods (`compose.yml` v3)

**No action required.** Two new optional variables; leaving them unset gives the
measured defaults baked into the image. Copy the new `compose.yml` to get the
override knobs.

### What changed

The T1 `asr-saturation` CRITICAL was keyed on `asrRtf{quantile=p95}`. It is now
keyed on the **share of scheduled job periods in which no pass ran at all**, at
50%. `ALERT_RTF_P95` survives only as the fallback for a transcription-service
too old to report that counter.

RTF was the wrong signal in kind, not merely mis-thresholded. A period whose pass
overruns is dropped, and the audio in it is left for the next pass, so per-pass
cost amortises over a longer buffer and **RTF falls as the service saturates**.
Measured on a GPU stack at 1/2/3/5/8 concurrent sessions: mean RTF 0.277 → 0.139
while the worker went 26% → 94.5% busy and transcripts per 1000 chunks collapsed
190 → 48. An alert on it was moving *further* from firing as captions failed.
Dropped periods rose monotonically through the same sweep.

### If you tuned `ALERT_RTF_P95`

Your value now applies only during a rolling upgrade, against a service that
predates the dropped-period counter. Tune `ALERT_ASR_DROPPED_PERIOD_CRITICAL_RATIO`
instead. Note also that `ALERT_RTF_P95` used to default to **1.0** when unset
even though the documented default was 2.0 — a schema default that outranked the
compiled one. If you never set it, your stack has been using 1.0, which fires on
a healthy deployment. It now falls back to 2.0 like the documentation says.

### The tail warning was silently inactive on CPU

`asr-tail-overrun` was floored at 100 *passes* in the 120s alert window. Two
problems: a CPU template at `job_period_ms: 5000` only gets ~24 scheduled periods
in that window (measured), so the floor was unreachable; and dropping a period
removes a pass, so the floor rose out of reach exactly as the fault got worse.
The counter path now floors on scheduled periods
(`ALERT_ASR_SCHEDULED_PERIOD_MIN_COUNT`, 20), a total dropping does not move. The
p99 fallback keeps the 100-pass floor, where the percentile-resolution argument
genuinely applies.

### The first poll no longer folds a service's lifetime

`AbsoluteStatusPoller` differenced each absolute total against the previous
reading, defaulting to zero. On the sidecar's *first* poll that meant a
long-running service's entire history landed as one increment stamped `now`, so
`asr-decode-drops`, `asr-buffer-overflow` and `upstream-churn` could all fire
immediately after a sidecar restart and clear themselves one window later. The
first poll now records baselines only. Expect to lose up to one poll interval of
counts when the sidecar starts; those events happened before it was watching.

### New variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `MONITORING_ASR_DROPPED_PERIOD_CRITICAL_RATIO` | `0.5` | drop share at which the T1 CRITICAL fires |
| `MONITORING_ASR_SCHEDULED_PERIOD_MIN_COUNT` | `20` | scheduled periods needed before either drop share is believed |

### CPU deployments

A full stack was run on `TRANSCRIPTION_DEVICE=cpu` for the first time. On an
RTX-class host's CPU (`small`, `cpu_threads` 4, 5000 ms period — the default at
the time; the shipped default is now `base`, which measures lower) a healthy
single session measured **mean RTF 0.45–0.479 and a 2.9% drop share**, and at 3
sessions **56.3%** — so the drop-share thresholds need no CPU override, but
`MONITORING_ASR_DUTY_RATIO` can still need one: the GPU-calibrated 0.45 sits
exactly on the healthy `small` value. Set it to **0.7** on CPU if running
`small`; with `base` (0.17) the default 0.45 has room. With that one line a
healthy CPU stack reports `{"alerts":[]}`.

Above ~3 concurrent sessions this CPU configuration stops working altogether: at
6 sessions every one was closed `1007 Client sent audio too quickly` and no
transcript was produced, with the load driver pacing correctly at realtime. That
is a capacity limit to plan around, not a setting to tune.

---

## Unreleased — **breaking:** a CUDA deployment now needs `-f compose.gpu.yml`

**If you run `TRANSCRIPTION_DEVICE=cuda` or `cuda128`, your start command changes:**

```bash
docker compose -f compose.yml -f compose.gpu.yml up -d
```

Without the overlay the transcription service starts on the CPU, whatever
`TRANSCRIPTION_DEVICE` says — the image will be the CUDA one and it will quietly
run without a device. Nothing crashes; captions just get very slow.

### Why

`compose.yml` reserved `driver: nvidia` unconditionally, with no reference to
`TRANSCRIPTION_DEVICE` — whose default is `cpu`. So the **documented default
configuration demanded a GPU**, and on a host without the NVIDIA runtime the
container was created and then refused to start with `could not select device
driver "nvidia"`, taking `node-server` down with it. A CPU-only server, or an
Apple Silicon Mac, could not start the default stack at all.

Compose cannot make a reservation conditional on a variable — there is no way to
omit a key — so the only question is which way the default points. It now points
at the configuration that needs no special hardware, because that is where someone
evaluating the project starts, and because a GPU deployment is already choosing
`TRANSCRIPTION_DEVICE` and reading this file.

The overlay contains exactly the device reservation and nothing else. It is not a
"production" overlay.

---

## Unreleased — the ASR job period is now per provider (`compose.yml` v2)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. Deployment
Check will report `old file` until you do. Nothing breaks if you delay: you lose one
derived series, described below.

### Why it changed

`TRANSCRIPTION_JOB_PERIOD_MS` was a single number (default `1000`) used as the
denominator of the derived **period-utilization** series. It cannot be a single
number. The CUDA templates run `whisper` and `crisper_whisper` at 500ms *alongside*
`lumen_granite` at 3000ms, so one value was wrong for at least two providers at all
times — 2× for whisper, 0.33× for lumen_granite — with no error and no warning. The
only provider it was ever right for was `debug`.

The format is now `provider=ms,provider=ms`:

```
MONITORING_JOB_PERIOD_MS=whisper=500,crisper_whisper=500,lumen_granite=3000   # CUDA templates
MONITORING_JOB_PERIOD_MS=whisper=5000,crisper_whisper=5000,lumen_granite=3000 # CPU templates
```

**It is empty by default, deliberately.** Any shipped default would be wrong for
somebody — CUDA is 500ms, CPU is 5000ms — and quietly misscaling the other group
would be the same bug in a new place. Unset means the sidecar publishes **no**
utilization series for that provider rather than a confidently wrong one. Set it
above to turn the series on; the new `scribear_asr_job_period_ms` gauge (labelled
`source=reported|configured`) shows which denominator is actually in use.

**A bare integer is now rejected** with an error naming the replacement, rather than
applied to every provider. If you had `MONITORING_JOB_PERIOD_MS=1000` in `.env`,
the sidecar will log that error and publish no utilization series until you convert
it to the map form. That is intended: a stale value should be loud rather than
silently averaged across providers it does not fit.

### What is unaffected

RTF and the transcription alerts. `asr_rtf` is measured by transcription-service
itself, and the duty-ratio warning added below is deliberately period-independent —
neither consults this variable. Only the derived period-utilization series does.

---

## Unreleased — transcription-service stops burning CPU it never used

Nothing to change in `.env` or `compose.yml`. Pull the new
`transcription-service-*` image and the CPU drop comes with it.

### What it was doing

A single streaming session on a GPU cost **2.4 cores** of CPU, peaking over
five, on a host whose actual inference was running on the GPU. Almost none of
that was work. Importing `numpy` loads OpenBLAS, which starts one thread per
core (19 on a 20-core host) and *spin-waits* between calls instead of sleeping.
The streaming provider re-transcribes its whole buffer every `job_period_ms`, so
that pool never idled long enough to back off, and 19 threads spun for the life
of every session.

End to end, one session for 90s via `npm run asr:load`, 895 chunks each side:

| | transcripts/1000 chunks | CPU mean | CPU max | cores/session |
| --- | --- | --- | --- | --- |
| before | 174.3 | 238.8% | 513% | 2.39 |
| after | 176.5 | 33.5% | 101% | 0.34 |

Same transcripts, **7× less CPU**. Isolated to one 30s-buffer `transcribe` call
on an RTX 5070 Ti, whisper `turbo`, the waste is starker still — 4.59 cores
against 0.99, with latency slightly *better* (0.75s → 0.68s), the pool having
only added contention. Three concurrent sessions now fit inside a single core.

### If you set `OMP_NUM_THREADS` yourself

The images now set `OMP_NUM_THREADS=1` and `OPENBLAS_NUM_THREADS=1`. An
`environment:` entry in your own `compose.yml` still overrides them, and on the
CPU image raising them is a pessimisation, not a tuning knob: it restores the
spinning pool alongside the inference threads, competing for the same cores.

### CPU inference parallelism moved to `provider_config.json`

The cap above would otherwise have serialised CPU-device inference, which reads
the same variable — 61.8s against 17.97s for a 30s buffer. CTranslate2's thread
count is now set explicitly instead of inherited, and is configurable per
context:

```json
{
  "context_uid": "faster-whisper",
  "context_config": { "model": "turbo", "device": "cpu", "cpu_threads": 8 }
}
```

Unset means 4 on `cpu` (CTranslate2's own default, and parity with the previous
image: 19.33s against 17.97s, minus the 19 spinning threads) and 1 on `cuda`,
where the encoder and decoder are on the GPU and no CPU pool is wanted. Raise it
on a CPU deployment with cores to spare — but count workers first, since
`num_workers` copies of it each claim that many threads.

### Context tags in the templates lost their device suffix

**Nothing to do.** A context `tags` entry is only a match string, resolved
inside the one `provider_config.json` that declares it, so your existing file
keeps working untouched and nothing in the images or the API knows these names.
Called out only because a diff against the templates now shows it.

The CUDA template had been tagging a `"device": "cuda"` context
`whisper_cpu_context`, which reads as a misconfiguration to anyone debugging one
— it cost real time during the CPU investigation above. The device belongs in
`context_config`, which already states it, so the tags no longer repeat it:
`whisper_cpu_context` → `whisper_context`, and
`crisper_whisper_cpu_context` / `crisper_whisper_cuda_context` →
`crisper_whisper_context`. The CPU and CUDA templates now use one tag
vocabulary and differ only where they should, in `context_config`.

---

## Unreleased — the Deployment Check notices an out-of-date `compose.yml`

### A new `compose.yml` row on the Deployment Check page

`deployment/compose.yml` is not part of any image, so `docker compose pull`
never updates it. Until now nothing noticed: a stack could run this month's
images against last month's file, missing whichever services, environment
variables and wiring the new images expect, with every container reporting
green.

`compose.yml` now carries a version number of its own, and admin-server compares
it against the version its image was built for. The result is one more row at
the bottom of **Deployment Check → Deployed versions**, beside the containers:

| Status | What it means | What to do |
| --- | --- | --- |
| `in step` | The file matches these images. | Nothing. |
| `old file` | The images are newer than `compose.yml` — you pulled without copying the file. | Copy the current [`compose.yml`](compose.yml) from the repo over `deployment/compose.yml`, keep your `.env`, and run `docker compose up -d`. |
| `old images` | `compose.yml` is newer than the images — the file was copied but not everything was pulled. | `docker compose pull && docker compose up -d`. |
| `not reported` | The running file predates this check, so it is at least that old. | Same as `old file`: copy the current file and `docker compose up -d`. |

Expect `not reported` on the first upgrade to this release, until the new file is
in place.

**Nothing here can stop a stack from starting.** The version is a plain literal
in `compose.yml` — it changes what the console *reports* and never what runs,
it is not `:?`-guarded, and it is deliberately **not** an `.env` key: an `.env`
carried over from an older release is exactly the thing that goes stale, so
letting it supply this value would let the stale half of a deployment vouch for
the other half. There is nothing to add to `.env` for this, and editing the
literal by hand only makes the console report something untrue.

---

## Unreleased — audio meter and audio telemetry in the admin console

The admin console gains an **Audio meter** nav item and a live **audio health**
strip on each session card. The meter is the same self-contained page the
monitoring sidecar already serves, now reachable from the admin UI at
`/admin/audio-meter.html` through the existing nginx — no new service, no new
port, no nginx change.

### What the audio meter is for

It measures the **local microphone of the device that opens it** — run it on the
room's source machine, not the operator's laptop. An operator at the source
machine clicks the nav item; one who is remote copies the URL and sends it to
whoever is at the room's PC. The page needs a secure context (HTTPS or
`localhost`) for `getUserMedia`, so a deployment running nginx on plain HTTP to
a LAN IP will see the mic button fail — use HTTPS or open it from the machine
itself.

### The nginx image must be upgraded with the rest, or the meter is dead

`/admin/` is served with a Content-Security-Policy, and the meter page keeps its
DSP and UI in inline `<script>` blocks (it is one self-contained file on
purpose, so an audio engineer can copy it to a source machine). The SPA's
`script-src 'self'` blocks those, and it fails **silently**: the page renders in
full, the device list populates, "Start metering" does nothing, and every
readout stays an em-dash. Nothing on screen says why.

`scribear-nginx` therefore ships a policy for that one URL, naming the sha256 of
each script the page contains. **Deploying the new admin-webapp image against an
older nginx gives you the dead page**, and a stale nginx with a *newer* meter
page does the same thing, because the hashes will not match its content. Pull
both images together. To check a running deployment:

```sh
curl -sk https://<host>/admin/audio-meter.html -o /dev/null -D - | grep -i content-security
# script-src must list two sha256-… values; if it says only 'self', nginx is stale
```

The check that catches this before a release is a browser, not a request: a
`200` response and correct bytes prove nothing here, because the page that runs
and the page that is inert are byte-identical.

### Clipping is now measured as runs at the rail (behaviour change)

`clippingPct` on published audio telemetry changed meaning. It used to count
**any** sample within 1e-4 of full scale; it now counts samples at or above
**0.99** of full scale that belong to a run of at least **two consecutive**
samples — the same rule the standalone meter page has always used.

The old definition charged undistorted audio as clipping. A clean tone at full
scale reaches 1.0 at one isolated sample per crest, which at 16 kHz worked out to
12.5 % of samples — past the 1 % threshold for a red **clipping** chip. So:

- Sessions that showed a red `clipping` chip while sounding fine, and whose audio
  simply ran hot to full scale, will now read normally. If a room's chip
  disappears after this upgrade, that is this change, not a metering regression.
- Genuinely clipped audio is unaffected: a hard-limited source has flat runs at
  the rail and still reads far above the threshold (a sine driven 3.5 dB into a
  limiter reads ~62 %, identically on both surfaces).
- No dashboard, alert, or env-var change is needed. No other field moved, and
  nothing outside the dashboard's display and status derivation reads this field.

The two implementations are now held to one expectation table in
`tools/audio-meter-crosscheck/`, so this class of disagreement fails CI rather
than reaching an operator.

### Audio telemetry is now measured at several points in the pipeline

Previously the audio reading was taken inside the Whisper provider's worker. Two
consequences, both fixed here:

**Deployments not running Whisper had no audio telemetry at all, and the
dashboard reported that absence as a microphone fault.** Of the four providers
in `provider_config.template.json`, only `whisper` and `crisper_whisper` run
whisper-streaming. On a `lumen_granite` or `debug` deployment nothing published
an audio snapshot, and the dashboard maps "no snapshot on a live session" to a
red **no audio reaching ASR** chip. So *every healthy session showed a red audio
chip beside a green connectivity chip.* If your deployment runs `lumen_granite`
or `debug`, those false red chips disappear after this upgrade and you get real
audio health for the first time.

**Audio is now measured where it arrives**, before any provider sees it, plus at
each point downstream that can report. A session's snapshot carries a list of
stages:

| Stage | Where it is measured | What a problem here means |
| --- | --- | --- |
| `ingress` | audio arriving at Transcription Service, every provider | the source is not sending good audio — mic muted, unplugged, wrong input |
| `asr_input` | after the worker decoded it into the ASR's buffer | the pipeline is losing audio — dropped chunks, decode failures, a client sending faster than the window holds |
| `vad` | the speech the detector passed on (Whisper only) | voice-activity detection is gating too aggressively |

Each stage reports cumulative seconds of audio that passed it, so the console can
show **where** audio was lost rather than only that something is wrong. The
session detail page gains a table of these stages.

> ⚠️ **A green audio chip now asserts less than it used to.** It means the source
> is sending good audio. It no longer implies the ASR is producing, because the
> reading is no longer taken from a transcription result — a stalled model or an
> unreachable upstream now shows on the **connectivity** chip and as a gap
> between `ingress` and `asr_input`, not as an audio fault. This is deliberate:
> audio quality and pipeline liveness are two different questions and a single
> chip answering both answered neither reliably.

Operators who had learned "red audio chip = check the microphone" can keep that
reading — it is now more accurate, not less.

### One new env var, optional

`TRANSCRIPTION_AUDIO_SILENCE_THRESHOLD` sets the linear RMS level at or below
which a metering window reads as digital silence. It **defaults to `0.01`**,
which is the value the Whisper provider already used, so leaving it unset
preserves current behaviour exactly and no deployment has to add it. Raise it
only if rooms with a genuinely quiet but working mic are being flagged silent.

Otherwise the audio panel still rides `TRANSCRIPTION_REDIS_URL`, the same switch
the fleet view already uses. If the fleet view works in an environment, audio
telemetry is being published there too. The `audio-meter.html` page itself needs
no backend at all.

### The published payload shape changed

The value at `scribe:v1:audio:{sessionUid}` moved from flat level fields plus a
top-level `vadStats` to the `stages` list described above. Both the publisher and
the reader ship from this repo, and the key expires after 10 seconds, so a
rolling upgrade costs at most one dashboard refresh of missing audio telemetry —
there is nothing to migrate and no ordering requirement between services. If you
have anything of your own reading that key directly, it needs updating.

### Fleet telemetry now discards a snapshot it cannot parse (behaviour change)

`/fleet` validates every snapshot it reads from the backplane against the schema
it was published under, and **drops** any that does not match, rather than
serving it through unchecked. That applies to all four indexes: Node Server
instances, sessions, Transcription Service hosts and session audio.

For a healthy deployment this changes nothing — every publisher in the stack
ships from this repo, and each one is now pinned against the reader's schema by
a test that runs the real publisher and parses its actual bytes.

It matters in one situation: **a mixed-version fleet during a rolling upgrade**,
where an older instance may publish a shape this version no longer recognises.
Such an instance disappears from the fleet view until it is upgraded, instead of
appearing with blank or wrong fields. That is deliberate — a card populated from
an unvalidated payload is worse than an absent one, because nothing on screen
says which fields are trustworthy — but it means a fleet view that looks short
of instances mid-upgrade is reporting a real version skew rather than an outage.

Dropped snapshots are logged by `admin-server` at `warn`, one line per index per
minute, naming the index, a sample of the affected members and what specifically
failed to match:

```
dropped fleet telemetry snapshots that failed to parse
  indexKey=scribe:v1:transcription-hosts:index droppedCount=3
  droppedSample=[{ member: "ts-a", reason: "schema-mismatch",
                   errors: ["/workers/0/contextIds/0: must be integer"] }]
```

A steady stream of those lines after an upgrade has finished is a genuine
publisher/reader mismatch and worth reporting; during a rolling upgrade it is
expected and stops on its own.

### Where the page moved

The standalone meter page moved from `apps/monitoring-sidecar/public/` to the
shared `libs/audio-meter-page/` directory so both the sidecar and admin-webapp
serve the same file. The sidecar's `/api/monitoring/v1/audio-meter` route keeps
working unchanged for in-cluster/port-forward use; `AUDIO_METER_PATH`'s default
updated to match the new location, so an override is only needed if a deployment
had set it explicitly.

---

## Unreleased — every container reports what it was built from

The admin console's **Deployment Check** page gained a **Deployed versions**
table: one row per container, showing the version, commit, branch, build time
and image tags it was built from. Nothing to add to `.env` — the six new
admin-server variables all default to their compose service names.

### Why it exists

Every service knows its own build and no service knows anyone else's, so an
upgrade that pulled some images and not others has been invisible from inside
the stack. The health rollup cannot see it either: a container running last
month's image is a perfectly healthy container, and it stays green.

The table takes the commit the most containers report as the deployment's, and
names any container that disagrees. That is the case worth watching for — it is
what a `docker compose up -d` that half-failed, or a service pinned to a
different `IMAGE_TAG`, looks like from the outside.

### What the statuses mean

| Status | What happened |
| --- | --- |
| `reporting` | Answered with its build. |
| `old image` | Answered, and has no build document — the image predates this release, so it was **not** recreated by your last upgrade. |
| `no answer` | Could not be reached at all. The container is down, not stale. |
| `n/a` | `scribear-db` and `redis` have no HTTP surface to report a build on. Their versions still move with `IMAGE_TAG`; read them with `docker compose images`. |

The first upgrade to this release is the one time `old image` is expected: it
appears for anything that has not been recreated yet. Run `docker compose up -d`
in `deployment/` and re-check — every row should turn to `reporting`.

### Locally built images

`build-containers.sh` now stamps the commit it built from, marks the image as a
local build, and appends `-dirty` when the working tree had uncommitted
changes. A stack started straight from a checkout (`npm run dev`) has no image
to stamp and says so, rather than showing a table of blanks.

### Reading it without the console

Every value is also an image label, so a shell on the host answers the same
question:

```
docker compose images
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  ghcr.io/scribear/admin-server:latest
```

### Note for anyone building images by hand

`scribear-nginx` now builds from the repository root rather than from
`infra/scribear-nginx`, because it shares the webapps' build-info generator:

```
docker build -f infra/scribear-nginx/Dockerfile .
```

`build-containers.sh` and CI already do this; only a hand-rolled `docker build`
needs changing.

---

## 0.3.0 — migrations run themselves

Every deploy now applies the database schema as part of `docker compose up
-d`, instead of relying on someone remembering to run a separate script
afterwards. Nothing new to add to `.env` — if you already run `docker compose
up -d` for every upgrade, you get the new behaviour for free.

### What was wrong before

`run-migrator.sh` used to `docker run` a throwaway `node:24-alpine`
container, `git clone` `https://github.com/scribear/scribear.git`, check out
`staging`, `npm ci`, and run the migrator from that checkout — and it exited
0 the moment the database had *any* table at all:

```
Tables detected! Database is already configured. Exiting setup...
```

That check was meant to skip a virgin database that did not need
initialising, but it also skipped every database that already had a schema —
which is every database after the first deploy. In practice the script only
ever did anything once, on day one; every later release's migrations were
silently never applied unless someone ran them by hand. It also always
applied whatever `staging` held at that moment regardless of the `IMAGE_TAG`
a deployment was actually pinned to, and it needed the bundled `scribear-db`
container on the `backend` network, so it could not target an external
Postgres, and it was the wrong tool for a locally built image since it
applied the published schema instead of the working tree.

### What runs now

`compose.yml` gained a `db-migrate` service: the same image and `IMAGE_TAG`
as `session-manager`, running a second entry point (`dist/migrate.mjs`) that
applies whatever migrations are pending and exits. `session-manager` and
`admin-server` both `depends_on: db-migrate: {condition:
service_completed_successfully}`, so `docker compose up -d` migrates the
schema before either service starts, and a failed migration means neither
starts — the reason is in `docker compose logs db-migrate`, not scattered
across two crash loops. It is idempotent: `docker compose up -d` re-runs it
every time and it exits in about a second when nothing is pending.

The migrations themselves are unchanged and the migration table is still
`kysely_migration`, so an existing database needs no special handling — the
job just picks up wherever it left off.

`run-migrator.sh` is now a thin wrapper around the same job —
`docker compose run --rm db-migrate` — for applying migrations on their own
without starting the rest of the stack, or to see the migration output by
itself. Nothing is cloned or installed at run time any more; it applies
whatever the pinned `IMAGE_TAG` ships, which also means it now works against
an external Postgres, since the job reads only the `DB_*` variables (see
_Running Postgres or Redis outside the stack_ below, updated for this).

### Readiness and the admin console now know when the schema is stale

`GET /api/session-manager/v1/probes/readiness` reports the database and the
schema as separate checks and returns 503 if either fails:

```json
{ "status": "fail", "checks": { "database": "ok", "schema": "fail" } }
```

`schema: "fail"` means this build ships migrations the database has not
applied yet. A database *ahead* of the build — what a rollback looks like —
is deliberately not treated as a failure; the service just runs with more
schema than it uses. Once the schema catches up the service goes ready on its
own, with no restart needed.

A new admin-key-protected route, `GET
/api/session-manager/v1/database/schema`, reports the full picture:
`{ initialized, applied, expected, pending, unknown, upToDate, latestApplied,
latestExpected }`. The admin console's **Config Check** uses it to raise:

- `schema-never-migrated` — the migration table does not exist yet.
- `schema-migrations-pending` — the database is behind this build.
- `schema-ahead-of-containers` — the database is ahead of this build (a
  rollback, most likely).
- `schema-version-skew` — session-manager and admin-server were built
  against different schema versions, which means they are running mixed
  `IMAGE_TAG`s.
- `schema-version-unreadable` — the database answered but the migration
  table could not be read, usually a permissions problem.

### Rollback

Reverting `compose.yml` to the previous release drops `db-migrate` and the
`depends_on` entries pointing at it; nothing here rewrites data or removes a
migration, so the schema is simply left where it is.

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

> **Superseded.** `MONITORING_CANARY_DEVICE_TOKEN` and the one-time device
> registration below no longer exist — see the unreleased "the monitoring canary
> is seeded, not provisioned" section at the top of this file. The safety note
> still stands, and is now enforced in code.

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

> **Removed as of `compose.yml` v7** — see the "watchtower is gone" entry near
> the top of this file. Left below as a historical record of what this release
> introduced.

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

### Postgres is no longer published on every interface

`scribear-db` published `5432:5432`, which binds **every interface the host
has** — on a public box that is Postgres exposed to the internet behind nothing
but `DB_PASSWORD`. It is now `127.0.0.1:5432:5432`.

Nothing in the stack is affected: services reach Postgres over the `backend`
network by hostname, and `run-migrator.sh` runs inside a container on that same
network. Only `psql` from the host itself still works — which is what the
publish was for. If you were connecting from another machine, that now needs a
deliberate choice (see below), and it is worth checking your access logs for who
else was.

> A host firewall is **not** a substitute here. Docker's DNAT rules are
> traversed before ufw's `INPUT` chain, so `ufw deny 5432` appears to apply and
> leaves the port reachable. Filtering a published Docker port means a
> `DOCKER-USER` rule. Binding the interface avoids the question.

### Running Postgres or Redis outside the stack

Production may want a managed or separately-administered database and cache
rather than the bundled containers. Both are supported; the split is that
**`.env` says where they are** and **`compose.override.yml` removes the bundled
services**.

#### Redis (easier — nothing depends on it)

Every consumer already takes a full URL, so pointing them elsewhere is `.env`
only:

```dotenv
REDIS_PASSWORD=<the external server's password>
ADMIN_REDIS_URL=redis://:<password>@redis.example.edu:6379
NODE_SERVER_REDIS_URL=redis://:<password>@redis.example.edu:6379
TRANSCRIPTION_REDIS_URL=redis://:<password>@redis.example.edu:6379
```

Then stop running the bundled one — `deployment/compose.override.yml`:

```yaml
services:
  redis: !reset null
```

> **Keep `REDIS_PASSWORD` set even though the container is gone.** Compose
> interpolates the base file _before_ merging the override, so the `${VAR:?}`
> guard on the removed service still fires and `docker compose up` aborts
> without it. Setting it to the external server's password — the same value used
> in the URLs above — keeps it honest rather than a dummy.

Use `rediss://` if the external server expects TLS.

#### Postgres

`DB_HOST` and `DB_PORT` are now read from `.env` (defaulting to the bundled
container), so the connection itself is configuration:

```dotenv
DB_HOST=pg.example.edu
DB_PORT=5432
DB_NAME=scribear
DB_USER=scribear
DB_PASSWORD=<managed instance password>
```

Removing the bundled service needs one more step than Redis, because
`session-manager`, `admin-server` and `db-migrate` itself all `depends_on`
it. Compose rejects a `depends_on` pointing at a service that no longer
exists —

```
service "admin-server" depends on undefined service "scribear-db": invalid compose project
```

— so the override has to replace those too. Keep `db-migrate` running — it is
what applies the schema to the external instance — and only drop each
service's dependency on the bundled container:

```yaml
services:
  scribear-db: !reset null

  db-migrate:
    depends_on: !override {}

  session-manager:
    depends_on: !override
      db-migrate:
        condition: service_completed_successfully

  admin-server:
    # Keep the session-manager and db-migrate dependencies; only drop the
    # database one.
    depends_on: !override
      session-manager:
        condition: service_healthy
      db-migrate:
        condition: service_completed_successfully
```

`!reset` and `!override` need Compose v2.24+ (`docker compose version`).

Verify the merged result before starting anything:

```
docker compose config | grep -E 'DB_HOST|REDIS_URL'
docker compose config --services      # scribear-db and redis should be absent
```

**Migrations.** `run-migrator.sh` now runs the `db-migrate` job
(`docker compose run --rm db-migrate`), which reads only the `DB_*` variables
above, so it already works against the external instance — no adaptation
needed. Just remember `db-migrate` is one of the services whose own
`depends_on: scribear-db` has to be dropped in the override above; keep the
job itself, only its dependency on the bundled container goes.

**Networking.** The services must be able to reach the external hosts from
inside their containers, which is a different question from whether the _host_
can. Check firewall rules and any egress restriction on the Docker networks.
`scribear-db`'s healthcheck no longer gates startup once the service is removed,
so a wrong `DB_HOST` surfaces as a service that starts and then fails its own
readiness rather than as a container that never starts.

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
