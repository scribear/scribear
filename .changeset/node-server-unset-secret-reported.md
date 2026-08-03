---
'@scribear/node-server': patch
'@scribear/node-server-schema': patch
---

An unset node-server secret no longer self-reports as healthy.

`isPlaceholder('')` was `false`, and that function feeds `secretPlaceholders` on
`GET /status` — the endpoint monitoring-sidecar polls and relays to
admin-server's Config Check. So an empty `SESSION_TOKEN_SIGNING_KEY`,
`SESSION_MANAGER_SERVICE_API_KEY` or `TRANSCRIPTION_SERVICE_API_KEY` was
rendered green on the page whose entire job is to notice exactly that. The env
schema declares them as bare `Type.String()` with no `minLength`, so an empty
value boots fine and the false-green was reachable rather than theoretical.

The fix is a deletion. `isPlaceholderSecret` in `utils/constant-time-equal.ts`
already treated empty as a placeholder — it was exported, never called, and
sitting a few files from a local duplicate that had drifted away from it. The
bug was the copy, not a missing capability.

Reporting empty *as* a placeholder, rather than adding a distinct "missing"
signal, is deliberate. admin-server keeps the two apart because there they have
different remediations — an empty `ADMIN_SESSION_SECRET` falls back to a random
per-boot value, which is a different failure from a shared `CHANGEME`. None of
these four has any such fallback: two are presented directly as bearer
credentials and one is used directly as an HMAC key, so empty and `CHANGEME`
are equally guessable and take the identical fix. A tri-state signal would have
required a new optional field across `node-server-schema`, the sidecar relay and
Config Check's consumption of it, plus the rolling-upgrade fallback — to tell an
operator something that does not change what they do.

The schema change is documentation only: the four field descriptions now say
"or unset". No shape change, so there is nothing to coordinate on a rolling
upgrade.
