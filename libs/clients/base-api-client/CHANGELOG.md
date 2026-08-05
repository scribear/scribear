# @scribear/base-api-client

## 0.3.0

### Minor Changes

- 01df4d4: The API client no longer rejects when a declared status arrives with a body
  that is not JSON.

  `createEndpointClient` promises a two-slot `[response, error]` tuple and
  promises never to reject — every caller in the repo destructures it without a
  `try`, and the middleware layers invoke those callers as
  `void service.joinSession(...)`. Only the `fetch` call was actually wrapped:
  `await response.json()` sat bare below it.

  That line is reachable far more often than it looks. `STANDARD_ERROR_REPLIES`
  declares 400/405/406/415/500 on essentially every route, so those statuses have
  a response schema and control flows straight past the undeclared-status escape
  hatch into the parse. But a declared status is no guarantee the _service_
  produced the body: a reverse proxy can serve its own HTML page under a 500, a
  400 can arrive with no body at all, and a dropped connection leaves truncated
  JSON. In each case `Response.json()` rejects, the rejection escapes the tuple
  contract, and the result is an unhandled promise rejection — the viewer presses
  **Join** and literally nothing happens. No error, no spinner, no state change.
  The undeclared-status path (502/503/504) was already safe; this was
  specifically declared-status-with-a-non-JSON-body.

  The parse is now wrapped, and the failure surfaces as `InvalidResponseBodyError`
  — a **subclass** of `UnexpectedResponseError`, not a sibling. That keeps
  `EndpointError` exactly as it was, so every existing `instanceof
UnexpectedResponseError` branch and every `error.status` read keeps working with
  no change at the call sites. Callers that want the distinction can test for the
  subclass: "there was no structured error body to read" points at infrastructure
  or a misconfigured proxy, where "the body was JSON but failed the declared
  schema" — still a plain `UnexpectedResponseError` — points at version drift
  between client and service. The original `SyntaxError` or `TypeError` is
  preserved as `cause`.

  The 204 short-circuit still runs before the parse, so a legitimately bodyless
  response is unaffected; a survey of the declared response schemas confirms 204
  is the only status ever declared bodyless, which is why an empty body on any
  other declared status is correctly an error rather than a silent `null`.

  Covered by tests for an HTML error page on a declared 500, an empty and a null
  body on a declared 400, truncated JSON, a body stream that fails mid-read, the
  preserved `cause`, and regressions pinning that schema mismatch stays a plain
  `UnexpectedResponseError`, that 204 never reaches the parse, and that an
  undeclared 502 with an HTML body still returns before any parse.

## 0.2.0

## 0.1.0
