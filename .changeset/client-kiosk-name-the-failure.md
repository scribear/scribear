---
'@scribear/client-webapp': minor
'@scribear/kiosk-webapp': minor
---

The viewer and the kiosk now say which kind of failure happened, and stop
burning their retry budget on a rate limit in under five seconds.

**`InvalidResponseBodyError` has consumers.** It was introduced so a caller
could tell "there was no structured error body at all" from "the body was JSON
but failed the declared schema", and nothing branched on it, so both rendered
the same generic fallback.

Splitting it exactly two ways would have been wrong, though, and the reason is
worth recording. nginx's `location /api/session-manager/` sets no
`proxy_intercept_errors` and no `error_page`, so when the upstream is down
nginx's own 502/503/504 arrive as **undeclared** statuses — which
`createEndpointClient` short-circuits into a plain `UnexpectedResponseError`
*before* it ever tries to parse a body. Under a literal two-way rule, the most
common infrastructure-down signal in this deployment would have been labelled
*"this app may be out of date, reload the page"*: advice that cannot help,
aimed at the wrong party, while the service is simply down. Gateway statuses
are therefore folded in with `InvalidResponseBodyError` as
`SERVICE_UNREACHABLE`, and `VERSION_MISMATCH` is reserved for genuine contract
drift. The same distinction carries into the refresh path, so the terminal
message after the budget is spent says which of the two occurred.

**The refresh backoff is rate-limit aware.** `@fastify/rate-limit`'s bundled
`LocalStore` is a **fixed** window — it resets the whole bucket at
`iterationStartMs + timeWindow` rather than decaying — so the useful client
behaviour is to spread retries across roughly one window, not to pace at the
limit rate. A rate-limited viewer was spending its entire five-attempt budget
in about 4.5 seconds and going terminal, advising a reload that landed in the
same overload. Rate-limited retries are now spaced 15 seconds apart, spending
the same bounded budget over about 60 seconds, which gives the window a real
chance to roll over. Every other failure cause keeps the fast exponential
schedule.

`Retry-After` is deliberately not read — `createEndpointClient` returns
`{status, data}` and discards headers — and the window is referenced as a
shipped default rather than scraped, since those numbers now live in
session-manager's `AppConfig`.

Also corrects two kiosk comments that blamed `exchange-device-token` for a 429
it cannot structurally produce: that route has no rate limiter at all.
