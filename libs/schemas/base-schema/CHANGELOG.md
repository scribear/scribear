# @scribear/base-schema

## 0.3.0

### Minor Changes

- 28e03b1: A rate-limited join no longer tells the whole room to do the thing that caused
  it.

  `exchange-join-code` and `refresh-session-token` are rate-limited at 100
  requests / 60 s per client IP — they are the only unauthenticated routes in
  session-manager, so they are the credential-guessing surface. A lecture hall
  behind one campus NAT shares a single client IP and trips that limit
  collectively, which is the normal case, not the attack case.

  429 was deliberately undeclared on both routes, on the theory that a status
  emitted by middleware has no service-owned body. That is not true here: the
  `errorResponseBuilder` in `create-server.ts` throws `HttpError.rateLimited(...)`,
  so the body goes through the base error handler and lands in the canonical
  `ErrorReply` shape like any other thrown error. Undeclared, though,
  `createEndpointClient` reported it as `UnexpectedResponseError`, the client
  collapsed that into `JoinError.UNKNOWN`, and the viewer read **"Unable to join
  session. Please try again."** — an instruction every seat in the room follows at
  the same moment, producing the next round of 429s. The refresh path was worse:
  five failed refreshes terminated the session with "…join again with a new join
  code", and a new join code is exchanged over a rate-limited route too.

  Both routes now declare `429: RATE_LIMITED_REPLY_SCHEMA` (new, exported from
  `@scribear/base-schema`). It is deliberately **not** added to
  `STANDARD_ERROR_REPLIES`: session-manager registers `@fastify/rate-limit` with
  `global: false`, so these two routes are the only ones that can emit a 429, and
  declaring a status a route can never return puts a phantom arm in every caller's
  response union and a phantom entry in the generated OpenAPI. A test pins that
  exhausting one route's window leaves an un-opted-in route answering 401, not 429.

  Client-side, 429 gets its own `JoinError.RATE_LIMITED` with wording that names
  the cause and gives a next action that does not reproduce it:

  > Too many people are joining at once. Wait a minute, then try the same join
  > code again — this clears on its own.

  It renders as `warning`, not `error`, per the severity convention (`warning` =
  transient/self-clearing), and no longer marks the join-code field invalid —
  nothing is wrong with the code that was typed. The refresh path records whether
  its most recent failure was a 429 and, if so, ends with:

  > Too many people are reconnecting at once, so this session could not renew its
  > access. Wait a minute, then reload this page — you do not need a new join
  > code.

  The rate limiter does set a `retry-after` header (in seconds, never larger than
  the window), and there is a test pinning it, but `createEndpointClient` returns
  only status and body — headers are not reachable from a typed endpoint client —
  so nothing in the UI promises the user a specific countdown.

## 0.2.0

## 0.1.0
