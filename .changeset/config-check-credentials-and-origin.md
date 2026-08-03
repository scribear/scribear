---
'@scribear/admin-server': minor
---

Config Check grades the local admin password, proves the test-audio key works,
and flags a public origin nobody outside the building can reach.

**A one-character admin password used to pass every check green.**
`ADMIN_LOCAL_CREDENTIALS` had no length or entropy check at all, unlike
`ADMIN_SESSION_SECRET`. It is a `"<username> <password>"` pair split on the
*first* space — so the password may contain spaces, and measuring the raw
variable would have measured the username too. The parse now mirrors
`LocalAuthService` exactly, and applies an 8-character floor (NIST SP 800-63B /
OWASP ASVS L1), deliberately **not** the 32-character bar used for
`ADMIN_SESSION_SECRET`: that is a machine-generated token, this is a
human-memorised password, and holding them to one standard would be the wrong
kind of consistency.

Working out that format turned up a second gap worth its own finding: a value
with no space, an empty username, or an empty password causes `LocalAuthService`
to **silently disable local login at boot**, while the existing
`localLoginEnabled` flag — a bare `.trim() !== ''` — cannot see it. A deployment
could have no working login method and no finding saying so.

**`TEST_AUDIO_SERVICE_KEY` is now live-probed**, as `GRAFANA_ADMIN_PASSWORD`
already was. A key that is present but *wrong* was indistinguishable from one
that works. The probe reuses the existing gateway and calls `listDevices()` — a
cheap `GET`, no audio job triggered — and keeps three outcomes distinct:
`401`/`403` is a mismatch (critical outside development); unreachable,
unparseable or an unexpected status collapse into a `probe-unavailable` warning
that is **never** critical and never reads as a pass; `2xx` is silence. It skips
entirely when the key is still a placeholder, so that finding is not buried, and
so two sides sharing the same placeholder cannot read as "verified".

**The public-origin check says what it cannot know.** There is no
`PUBLIC_ORIGIN`-style variable anywhere in this stack — nginx's `server_name` is
the wildcard `_`, and `join-url.ts` / `kiosk-url.ts` build every join link and QR
code from `window.location.origin` in the operator's own browser. The only place
that origin is visible to admin-server is the `Host` header of the request
asking for the report, so this check is necessarily **request-scoped, not
deployment-scoped**, and it is deliberately one-directional: it flags origins
that certainly will not work off-host — loopback, RFC1918, link-local, `.local`,
a bare single-label hostname — and stays silent on anything else. A normal
looking FQDN is reported as *not ruled out*, never asserted reachable, because
admin-server sits inside the backend network and an in-cluster fetch would prove
almost nothing. The finding's own text states that limit rather than implying a
confidence it does not have.
