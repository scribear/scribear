---
'@scribear/node-server-schema': minor
'@scribear/session-manager-schema': minor
'@scribear/node-server': minor
'@scribear/session-manager': minor
---

A credential problem now always answers 401. It could answer 400, including for
a key that was correct.

`SERVICE_API_KEY_AUTH_HEADER_SCHEMA` and `ADMIN_API_KEY_AUTH_HEADER_SCHEMA`
pinned the `Authorization` header to `^Bearer [A-Za-z0-9_-]+$`. Fastify runs
request validation *before* the preHandler that checks the key, so that pattern
decided the status code for credentials the auth hook never saw. A key from
`openssl rand -base64 32` contains `+`, `/` and `=`, none of which the class
allowed, so such a deployment got `400 VALIDATION_ERROR` on every call — correct
key or not — while a merely *wrong* hex key got 401. Verified live through the
public origin: `Bearer abc+def/ghi=` → 400, wrong hex key → 401. Which generator
an operator happened to reach for decided whether their deployment
authenticated. `openssl rand -hex 32`, which `deployment/UPGRADING.md`
recommends, dodges it by luck.

This directly contradicted the reasoning already written beside it, which
explains that the header is left *optional* precisely so that missing and wrong
credentials both answer 401, "which is one thing for a consumer to alert on".

The pattern is gone. Rejected: widening the class to cover base64, base64url and
hex (plus `.` for JWT-shaped keys). That shrinks the blast radius without
removing it — it is still a guess about what an operator's secret manager emits,
and a guess wrong by one byte still tells someone holding the right credential
that their *request* was malformed. There is no encoding these services need the
key to be in, so there is nothing for a pattern to assert. It costs no security
either way: the pattern was never the control — the constant-time comparison in
`ServiceAuthService.isValid` / `AdminAuthService.isValid` is — and those methods
already reject anything without the `Bearer ` prefix, so removing it only moves
that answer from 400 to 401. `description` and `examples` keep the OpenAPI
documentation the pattern was incidentally carrying.

The admin key path had the same hazard and one worse: session-manager's 32
admin-key routes declared `authorization` as a *required* header, so a caller who
forgot it entirely got `400 must have required properties authorization` while a
caller who got it wrong got 401 — two alerts for one problem. All 32, plus
`session-config-stream`, now wrap the header in `Type.Optional`, matching what
node-server's `/status` already did on purpose. Every one of those routes is
covered by `adminApiKeyHook`/`serviceApiKeyHook` (verified 32 schema
declarations against 32 preHandler attachments), so the hook is still the only
gate.

Pinned by tests at both levels: unit tests walk every exported route schema in
both packages and fail if any reintroduces the pattern or makes the header
required, and integration tests assert 401 — never 400 — for an absent header, a
base64-shaped key, a non-Bearer value and a wrong key, plus a 200 for a
*correct* base64-shaped admin key, which is the case the old pattern broke.
