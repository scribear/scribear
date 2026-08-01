---
'@scribear/session-manager-schema': minor
'@scribear/session-manager': minor
'@scribear/admin-server': patch
---

A `transcriptionProviderId` naming no configured provider is now rejected when
it is typed, not when a room full of people tries to use it.

The field was free-text `Type.String()` on five write paths — `create-schedule`,
`update-schedule`, `create-auto-session-window`, `update-auto-session-window`
and `create-on-demand-session` — and nothing checked it. An unknown key made
transcription-service raise `TranscriptionClientError("Invalid Provider Key")`
and close the **upstream** socket 1007, node-server retried a permanently
unsatisfiable request forever, and every viewer of that room saw only the
generic reconnecting banner. Nothing in the stack named the cause; the typo was
made once, by an operator, at a keyboard.

Session Manager now validates against `TRANSCRIPTION_PROVIDER_IDS`, a
comma-separated env var defaulting to the set in
`provider_config.template.json` (`debug`, `whisper`, `lumen_granite`,
`crisper_whisper`), so a stock deployment needs no new configuration. A key
outside it answers **400 `VALIDATION_ERROR`** — already declared on every one of
those routes via `STANDARD_ERROR_REPLIES`, and the same answer those routes
already give for `INVALID_ACTIVE_END` and friends, so no wire contract changes —
with a message naming the accepted keys, because the operator cannot see the
deployment's provider set from the console.

Three designs were considered:

- **A live lookup** against transcription-service's `/providers/health`.
  Rejected: it needs `METRICS_API_KEY`, a credential session-manager does not
  have and should not acquire (it otherwise never talks to transcription-service
  at all), and it would make creating a session fail whenever
  transcription-service is unreachable — a worse failure than the one being
  fixed.
- **A fixed union in the published schema.** Rejected: `provider_config.json`
  is operator-editable deployment config, so a hardcoded enum would reject a
  provider an operator legitimately added and accept one they removed. That is
  the same mistake as pinning the `Authorization` header to a character class
  and guessing what an operator's secret manager emits.
- **Deployment configuration**, which is what shipped. It is wrong loudly in
  both directions: too narrow and a create fails immediately with the accepted
  keys in the message; too wide and behaviour is exactly what it is today, which
  the new `invalid-request` disconnect reason now surfaces to the viewer anyway.

`SHIPPED_TRANSCRIPTION_PROVIDER_IDS` and `TRANSCRIPTION_PROVIDER_ID_SCHEMA` are
exported from `@scribear/session-manager-schema` so the default and the OpenAPI
documentation come from one place; the wire type is still a plain string.

`compose.yml` gains the variable next to the `provider_config.json` mount and
bumps to **v8** (`EXPECTED_COMPOSE_FILE_VERSION` follows), with the operator
note in `UPGRADING.md`: if you have edited `provider_config.json`, the two files
now have to agree.

Ten tests, five per level, one per write path, all failing against the old
behaviour — plus one that walks every shipped id and asserts it is accepted,
which is as much a guard on the comma-splitting as on the check.
