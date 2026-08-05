---
'@scribear/scribear-nginx': minor
---

The site root now opens the client webapp instead of 404ing.

`nginx.conf` routed `/client/`, `/kiosk/`, `/standalone/`, `/admin/`,
`/grafana/` and the `/api/...` prefixes, and nothing at all at `/` — there is no
`location /` in the TLS server, so the bare hostname returned nginx's own 404.
That is the URL a person types by hand into a lecture-room browser, and it was
the one URL in the deployment that led nowhere.

`location = /` now returns a 302: to `/client/` for an onsite visitor, and to
`/extlanding` for a gated one — the same landing page every other frontend
surface already redirects to, so the onsite gate's behavior for an outside
visitor is unchanged. Exact match, so `/` alone is affected and every other
unrouted path still 404s.

**302, not 301/308.** What `/` resolves to depends on which network the visitor
is on, so a permanent redirect would be cached by the browser and replayed for
the same person after they leave campus — exactly the distinction this location
exists to make.

**`Cache-Control: no-store` as a literal, not the `$onsite_no_cache` map.** The
map is empty on the allowed path because the gated locations *proxy* there, and
an upstream's own `Cache-Control` on hash-versioned assets must be left alone.
Here both branches are IP-dependent redirects, so neither may be stored.

**`absolute_redirect off`.** nginx otherwise expands a relative redirect against
`$host`, which drops a non-default port: on the dev/iso stack published at
`:8443` the browser was sent to `https://<host>/client/` on port 443 — a
different stack on the same machine. Observed against a real container, not
theorised. The neighbouring `/client` and `/grafana` 308s share the quirk and
are deliberately left alone here rather than widening this change.

Verified end-to-end against `ghcr.io/scribear/scribear-nginx` with the shipped
config and both a permissive and a `default 0` allowlist: onsite `/` → 302
`/client/` (relative, port preserved) → 200 from the client webapp; gated `/` →
302 `/extlanding` with `X-Onsite-Gate: denied` → 200 landing page; `/healthz`
200, an unrouted path 404, and an API still 403 off-campus. `onsite-gate.test.ts`
now covers the root as an eleventh gated location — including the two ways it
legitimately differs from the others (no `proxy_pass` to run ahead of, and the
literal `no-store`), so neither can be quietly dropped.
