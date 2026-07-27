---
'@scribear/admin-server': minor
---

Admin BFF for the operator test-audio devices: proxy, audit and safety for the
two synthetic sources, with no device tokens held here.

`apps/test-audio-generator` runs two synthetic source devices — `good`, which
plays clean speech at an adjustable level and noise floor, and `fault`, which
reproduces on demand every audio fault the stack claims to report. It holds
long-lived device tokens and a soft-realtime send loop, so it is a service of
its own; this is the admin console's front door to it (PLAN-TestAudioDevices
§3).

- **`GET /api/admin/v1/test-audio`** — both devices and their live state, plus
  the BFF's own `available` flag. **`POST /:deviceId/start`**,
  **`POST /:deviceId/stop`**, **`PATCH /:deviceId/params`** — start a bounded
  run, stop it, and retune a *running* device without restarting the stream.
  `deviceId` is `good` or `fault`, rejected here rather than upstream.
- **Guarded like `rooms`.** Reads take `requireSessionHook`; every mutation
  takes `requireSessionHook + csrfHook + requireRole('read-write')`. These
  point a synthetic source at a real room, so nothing weaker would do.
- **Audited by the knob.** Every mutation writes one audit row through
  `auditedMutation`, with the parameters that changed in `paramsSummary` —
  which knob the operator turned, at what setting, for how long, is the entire
  value of the row. `auditedMutation`'s `gateway` is now structural
  (`MutationGateway<TResult>`) so a feature with an upstream of its own audits
  through the same helper rather than a second copy of it.
- **`TEST_AUDIO_BASE_URL` + `TEST_AUDIO_SERVICE_KEY`, both empty by default.**
  Empty base URL disables the feature: the read answers
  `{ available: false, devices: [] }` at **200**, and mutations answer 503
  `TEST_AUDIO_UNAVAILABLE`. Most deployments never provision these devices, and
  an unprovisioned one should see a disabled panel rather than an error it has
  to rule out — the same shape `REDIS_URL` uses for fleet telemetry. Neither
  variable is required to boot.
- **The service key never leaves the server.** `TestAudioGatewayService` is the
  only thing that knows where the generator lives and the only place the key is
  used, shaped like `sessionManagerGatewayService`; it injects
  `Authorization: Bearer` itself. The admin session — cookie, CSRF token,
  identity — is never forwarded: the generator authenticates this service, not
  the operator behind it. A generator that rejects the key surfaces as 502
  `BACKEND_MISCONFIGURATION`, never a 401, so an `.env` mistake cannot bounce
  the operator to the login page; an unreachable one surfaces as 503
  `TEST_AUDIO_UNREACHABLE`, and its own 4xx passes through at its own status
  and code.
