---
'@scribear/admin-server': minor
'@scribear/admin-webapp': minor
---

The admin console now asks the one service that already knows whether captions
are working.

The monitoring sidecar evaluates a set of rules — the synthetic caption canary,
transcription saturation and worker-death, ASR buffer overflow, auth-failure
ratio, per-service probe-down, clock skew — and had exactly one consumer:
Grafana. admin-server called the sidecar once, for `/config-audit`, and the
console never asked for alerts at all. An operator looking at the dashboard
during an outage was looking at the one page that could have told them, and it
was silent.

`GET /api/admin/v1/alerts` proxies the sidecar's `/api/monitoring/v1/alerts`,
reusing the existing `MONITORING_SIDECAR_BASE_URL` and health-check timeout —
no new environment variable, and no new credential, because that sidecar route
is reachable unauthenticated over the backend network exactly as `/config-audit`
already is. Evaluation stays pull-based and stateless: the sidecar recomputes on
every call and sorts worst-first, so "current alerts" is simply what the call
returns.

**"No alerts firing" and "we could not ask" are kept unrepresentable as the
same state**, which is the entire point. The service raises rather than falling
back to an empty list on every failure path — network error, non-2xx,
unparseable body, schema-invalid body — and the route answers `503
ALERTS_UNAVAILABLE`. The hook returns a discriminated
`loading | ok | unavailable` rather than `{alerts: [], error}`, following the
discipline that `useAsyncList` still needs. An empty green list says every
monitored rule is currently green; an unreachable sidecar says so in its own
banner, in as many words, and does not borrow the green state's wording.

Severity maps `critical → error` and `warning → warning`. The sidecar has no
`info` tier by construction — a rule appears only while firing, so health is
the *absence* of alerts rather than a severity — and each rule already carries
a `likelyCause` that names both the cause and the remediation, so no separate
next-action field was needed.

Accessibility follows the console's established patterns: severity is never
colour-alone (each alert carries a text chip and an icon), a single
`aria-live="polite"` rollup announces error/warning counts rather than letting
a 15-second-polled list re-announce every card, and the unreachable-sidecar
state uses an assertive `role="alert"` since it is a one-time, action-worthy
change.
