---
'@scribear/admin-server': minor
'@scribear/admin-webapp': minor
---

An operator rate-limited by the admin server is no longer told their password
is wrong.

admin-server registers `@fastify/rate-limit` with `global: true`, so every
admin route can answer 429 — and the login route tightens the limit further.
It already had an `errorResponseBuilder`, so the body was well-formed all
along; what was wrong was the rendering. The console showed the server's
log-facing string, *"Too many requests. Please retry after 1 minute."*, at
`error` severity, in the same red slot as *"Invalid credentials."* A rate
limit is transient and self-clearing, and telling someone their sign-in was
rejected when it was merely deferred is the worst version of that mistake.

It now renders as a `warning`, says a rate limit is what happened, says nothing
was changed (the limiter rejects in `onRequest`, before any handler runs), and
does not imply an automatic retry, because nothing in the console retries.

`Retry-After` reaches the browser for the first time. It is set as a header,
which the console cannot read, but `@fastify/rate-limit`'s `context.after` is
already display copy — `"1 minute"`, `"45 seconds"` — so it moves into
`details.retryAfter` on the error envelope and the wording can name the actual
wait.

**No schema change**, which is the opposite of what this looked like from the
outside. It would be natural to add 429 to `STANDARD_ERROR_REPLIES`, on the
grounds that admin-server's `global: true` is the mirror image of
session-manager's `global: false`. It is not: admin-server declares **no**
`response` map at all — it is a BFF with its own `{ok, error}` envelope — and
`admin-webapp` does not use `createEndpointClient`. All 46 spread sites belong
to session-manager and node-server, both `global: false`, so the change would
have added an unreachable arm to 46 schemas and done nothing for admin. A note
in `error-reply.schema.ts` records why, so the next reader does not have to
re-derive it.

Along the way, twelve hand-rolled copies of
`err instanceof ApiError ? err.message : fallback` collapse into one shared
helper, and `ToastSeverity`'s `'warning'` — which had existed in the type and
carried a WCAG contrast override in the provider, but which no caller could
reach — finally has a producer.
