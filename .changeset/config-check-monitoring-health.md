---
'@scribear/admin-server': minor
---

Config Check reports two more placeholder secrets, and whether the monitoring
profile is actually working rather than merely switched on.

`TEST_AUDIO_SERVICE_KEY` and a placeholder password inside `ADMIN_REDIS_URL`
are both in admin-server's own environment and were simply never checked.
`TEST_AUDIO_SERVICE_KEY` is unconditional rather than gated on
`TEST_AUDIO_BASE_URL` being set, because that variable defaults to the in-stack
service and the generator refuses to start on an empty or `CHANGEME` key — the
secret is live by default, unlike the off-by-default telemetry gate.
`ADMIN_REDIS_URL` reuses the existing `redisUrlHasPassword` convention where an
unparseable URL returns false rather than flagging, deferring that case to the
reachability check. A placeholder Redis password therefore produces *two*
findings — `redis-url-placeholder-password` and `telemetry-unreachable` — and
that is correct rather than duplicated: one is a static fact about the URL
string, the other is what the deployment actually observes.

The monitoring checks close a gap the `monitoring` compose profile opened:
turning it on and having it silently not work looked identical to having it
work. Config Check now verifies Prometheus is reachable **and** lists the
`scribear_sidecar` scrape target as up (a reachable Prometheus scraping nothing
is the failure that leaves every Grafana panel empty), that Grafana is
reachable, and that Grafana no longer accepts the `admin`/`CHANGEME` default
login. That last one is a probe rather than a credential — it attempts exactly
the well-known default against an authenticated route and reports whether it
succeeded — so admin-server never needs `GRAFANA_ADMIN_PASSWORD`.

Leaving monitoring off is itself reported (`monitoring-not-configured`, warning
in staging/production, advisory in development) rather than staying silent: a
fleet-health dashboard is worth nudging toward once a deployment is more than a
throwaway container. New env: `ADMIN_GRAFANA_BASE_URL`,
`ADMIN_PROMETHEUS_BASE_URL`, both empty by default and deliberately not
`:?`-guarded in `compose.yml` — an unset value must never block the stack from
starting. `COMPOSE_FILE_VERSION` bumped 5→6 for them, which is this repo's
established trigger for new env vars on an existing always-running service; the
prior monitoring-dashboard release's `UPGRADING.md` entry was titled
"(compose.yml v6)" without ever bumping the constant, and that header is
corrected here so it does not collide.

All findings use a new `'monitoring'` `CheckCategory`, so the subsystem groups
under one chip rather than splitting across `'monitoring'` and `'secrets'`.

**Removed before shipping: a Grafana dashboard-provisioning check.** It was
implemented and then deleted after live testing showed it fired even when the
dashboard genuinely was provisioned. `GET /api/dashboards/uid/...` requires
Grafana auth, and the only credential this check is permitted to try is the
well-known default — so it could succeed only on deployments that have *not*
secured Grafana, making it a guaranteed false positive on every properly
secured one. Not routed around by giving admin-server a real Grafana
credential (that trades a report for the security it reports on) or by enabling
anonymous access. `_checkGrafana` carries a doc-comment saying so.
