# Monitoring (Prometheus + Grafana)

An opt-in, zero-click fleet-health dashboard for anyone evaluating ScribeAR on
their own staging box. `docker compose --profile monitoring up -d` and a
working Grafana dashboard — sessions, RTF, dropped periods, worker health,
canary status — is already there, sourced from metrics the stack already
produces. See `PLAN-Grafana-Monitoring.md` in the repo root for the full
design rationale; this file is the operator-facing "how do I use it" doc.

**Not a production-grade, long-retention, HA monitoring stack.** This is an
evaluation/staging quick-win. Outgrow it by pointing Prometheus at your own
long-term-storage backend, or swapping Grafana for your existing instance —
see "Pointing your own Grafana at this Prometheus" below.

## Turning it on

Off by default, same mechanism `autoupdate` uses. In `deployment/.env`:

```dotenv
COMPOSE_PROFILES=monitoring
GRAFANA_ADMIN_PASSWORD=<a real password, not CHANGEME>
```

`GRAFANA_BIND`, `GRAFANA_PORT` and `PROMETHEUS_RETENTION` all have sensible
defaults (see `.env.example`) — only the password needs changing. Then:

```sh
docker compose --profile monitoring up -d
```

Log in to Grafana (`admin` / your `GRAFANA_ADMIN_PASSWORD`) and the
**ScribeAR Fleet Overview** dashboard is already there, already rendering —
no "Add data source," no "Import dashboard."

## Reaching Grafana

Grafana binds to `127.0.0.1` on the host by default (`GRAFANA_PORT`, default
`3000`) — reachable on the box itself, not the network. From your own
machine:

```sh
ssh -L 3000:localhost:3000 <staging-host>
```

then open `http://localhost:3000`. To open it to the LAN instead, set
`GRAFANA_BIND=0.0.0.0` in `.env` yourself — an explicit choice, not this
stack's default. Prometheus itself is **never** host-published; it has no
`ports:` entry at all and is reachable only from Grafana, over the `backend`
compose network.

## Turning it off

```sh
docker compose stop prometheus grafana && docker compose rm -f prometheus grafana
```

**Do not use `docker compose --profile monitoring down`** to mean "turn
monitoring off" — `docker compose down` is not scoped by `--profile` the way
`up` is. It tears down every container in the project, monitoring or not.
`docker compose --profile monitoring down` (or plain `down`) is correct only
when you mean "stop the entire stack," which happens to include Prometheus
and Grafana if they were running.

`docker compose stop prometheus grafana && docker compose rm -sf prometheus
grafana` followed by `docker volume rm deployment_prometheus_data
deployment_grafana_data` additionally drops their data for a clean slate.

## Pointing your own Grafana at this Prometheus

Prometheus is backend-network-only by design (it ships with no
authentication of its own — see `PLAN-Grafana-Monitoring.md §2`), so an
external Grafana cannot reach it as-is. Two honest options, no third:

1. **Run your Grafana inside this compose network** (e.g. as another service
   in a `compose.override.yml` on the `backend` network) and point it at
   `http://prometheus:9090`.
2. **Deliberately publish Prometheus's port yourself** (e.g. via a
   `compose.override.yml` adding `ports: ["127.0.0.1:9090:9090"]` to the
   `prometheus` service, or an SSH tunnel) if you understand and accept that
   Prometheus has no login of its own — treat that port the way you would
   treat an unauthenticated database port.

There is no default third path where Prometheus is reachable off-box without
an explicit choice on your part.

## Adding a panel or a second dashboard

`deployment/monitoring/grafana/dashboards/scribear-fleet-overview.json` is
the source of truth for the seed dashboard — dashboards-as-code, matching
this repo's existing config-as-code discipline. Building a first draft in the
Grafana UI and exporting the JSON back into this file is a fine way to
iterate; hand-editing the JSON forever is not the intent, but it is a plain
text file and small edits (adding a panel, tweaking a threshold) are
reasonable directly.

A second dashboard (e.g. a GPU-specific one, tracking device utilization and
VRAM) is a sibling JSON file in
`deployment/monitoring/grafana/dashboards/`, not a restructure — Grafana's
dashboard provisioner loads every JSON file in that directory automatically.

Every panel's datasource is the `${DS_PROMETHEUS}` Grafana template variable,
not a hardcoded UID — this is what makes the dashboard both auto-provision
cleanly here and import cleanly into any other Grafana that has a Prometheus
datasource, whatever it happens to be named there.

## What's exported, and the one known gap

`monitoring-sidecar`'s `/metrics` endpoint is the single source for every
panel — see its own docs for the full list of `scribear_*` series. One gap,
tracked as a deliberate follow-up rather than a defect: the sidecar does not
yet re-export transcription-service's admission-control fields
(`estimatedCapacitySessions`, `sessions_refused_capacity_total`), so this
dashboard cannot show a capacity-ceiling-vs-live-sessions panel the way
`admin-webapp`'s `CapacityMeterBar` does. `scribear_ws_close_total` broken
out by close code (see the "WebSocket close codes" panel) gives an indirect
signal today — a spike in code `1013` — until that gap is closed. See
`PLAN-Grafana-Monitoring.md §7`.
