---
'@scribear/admin-server': minor
'@scribear/admin-webapp': minor
---

Add a Config Check page to the admin console: `GET /api/admin/v1/config-check`
and an **Admin → Config Check** view that reports this deployment's
configuration posture and says which findings would be unacceptable in
production.

**The problem it solves.** Nothing in the stack tells an operator that their
admin password is still `CHANGEME`. Boot-time assertions catch the cases that
are indefensible everywhere, but they cannot catch the ones that are correct in
a dev container and a compromise in production — a guard that refuses to boot on
a placeholder password would make local development miserable, and one that
allows it says nothing at all in production. That gap is where this page lives.

**Severity is per environment, and every finding carries all three.** A new
`DEPLOYMENT_ENV` (development | staging | production) selects which standard the
report is judged against. Each finding also reports its `productionSeverity`
regardless of where it is evaluated, and the page surfaces the count of findings
that are critical in production as a banner. That is the part worth having: a
staging deployment can be entirely green and still be unfit to promote, and
without this the gap is invisible until it is a production incident.

`DEPLOYMENT_ENV` is a plain string with an empty default rather than an enum, so
adding it cannot stop an existing deployment from booting, and a typo is
reported by the check rather than by a boot failure. Unset infers **production**
unless the server was started with `--dev`. The asymmetry is deliberate: every
deployment predating this variable has it unset, and the two mistakes are not
equivalent. Guessing development would greet a real deployment with a page of
reassuring green while its admin password was public; guessing production shows
a developer a few findings they can dismiss in one read, or silence with one
line in `.env`.

**Scope, and where it stops.** admin-server can read its own environment and
nothing else's — no service discloses another's configuration, and adding an
endpoint that did would be a much larger liability than this page is worth. So
the checks are of two kinds. Direct ones over admin-server's own variables
(placeholder secrets, no login method configured, SSO without a group
restriction, `--dev` outside development — which silently clears `Secure` on the
session cookie). And *inferences* from observable behaviour for everything else:
a reachable-but-empty telemetry backplane means no node-server or
transcription-service has ever published, which is the only evidence available
that their `REDIS_URL` was never set. The inferences are phrased as what was
observed rather than as conclusions about variables this process cannot see.

**No secret ever reaches the response.** Findings carry a classification and a
length — never a prefix, suffix, or hash, since a prefix is directly useful and
a hash of a short secret is a slower way of disclosing it. The route is behind
`requireSessionHook`, but "authenticated" is not the same as "cleared to read
every credential in the deployment", and a config report is exactly the kind of
page that gets screenshotted into a ticket. A unit test asserts that no secret
value appears anywhere in the serialized findings.

The rule set is split into a pure `evaluateStaticChecks` and the two async
checks that need I/O, so the bulk of it is testable by construction — a false
`ok` here is indistinguishable from a well-configured deployment, which makes
these the rules most worth testing exhaustively.
