---
'@scribear/base-long-poll-client': minor
'@scribear/kiosk-webapp': patch
---

The long-poll client no longer emits a declared error body as if it were poll
data.

`_run()` carried the comment `// status === 200` and checked nothing. It
skipped 204 and treated *everything else* in the response slot as a payload.
That slot is fuller than it looks: `createEndpointClient` returns a declared
status as a typed **response** with a null error, on purpose, so a 401
`INVALID_DEVICE_TOKEN` or a 404 `DEVICE_NOT_IN_ROOM` — both declared by
`my-schedule`, as 401 `INVALID_SERVICE_KEY` and 404 `SESSION_NOT_FOUND` are by
`session-config-stream` — arrived with `err === null` and went straight out the
`data` event as `{ code, message }`.

The consequence was not a missing update; it was a *misleading* one. node-server
read `transcriptionProviderId` off a 401 body, got `undefined`, and dialed
`.../transcription_stream/undefined`; the transcription service refused the
request and the operator was shown `invalid-request` — sending them to hunt for
a provider-key misconfiguration that did not exist, when the actual fault was a
`NODE_SERVER_KEY` mismatch between node-server and session-manager. Two
unrelated causes collapsed into one wrong answer. On the kiosk the same path
threw inside the `data` listener (`for (const session of undefined)`), which,
because the poll loop is a `void`-ed async method, escaped the `while` and left
the client in `POLLING` with no request in flight and no retry armed:
permanently silent while `state` still read healthy.

Any response that is not 200 or 204 is now a failure. It surfaces as
`LongPollResponseError`, a **subclass** of `UnexpectedResponseError` (the same
relationship `InvalidResponseBodyError` has), so every existing `instanceof
UnexpectedResponseError` branch and `.status` read keeps working; the subclass
adds `.code` and `.body` so a consumer can name the cause. Both consumers
already had `error` handlers that report to a human, so the cause now reaches
one instead of being laundered.

No status is treated as terminal, 401 included. Nothing in the fleet re-mints a
credential on demand — the kiosk's `DEVICE_TOKEN` is replaced only by a human
re-activating the device, and node-server's service key only by a redeploy — but
both of those happen *while the client is running*, and a poll that had stopped
for good would not notice. Backoff caps the cost of waiting at one request per
30s. Relatedly, `_attempt` is now reset only after a genuine 200/204: resetting
it before the status check pinned a permanently-failing status (a wrong key
answering 401 forever) at `initialMs`, so backoff never grew and the client
retried a hopeless request once a second indefinitely.

Two adjacent hazards on the same path are closed. A 200 whose body has no
numeric `versionResponseKey` field now fails into backoff rather than emitting
with an unmoved cursor — the server answers 200 to that same cursor
immediately, so the old behaviour was a hot loop with no delay between
requests. And an exception thrown by a `data` listener is contained and
re-emitted on `error` instead of killing the poll loop.

The kiosk now names the two device-specific statuses on the wall banner —
"Re-activate the device from the admin console" for a 401, "Assign it to a room"
for a 404 — instead of the generic "The schedule service is failing (HTTP …)",
which blames the server for a device problem.
