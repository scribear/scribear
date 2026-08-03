import { Type } from 'typebox';

// No `pattern` here, deliberately, and this is the canonical explanation for
// every copy of this schema (see also session-manager-schema's
// admin-api-key.ts and service-api-key.ts).
//
// Fastify runs request validation *before* the preHandler that checks the key,
// so any pattern on this header decides the status code for a credential the
// auth hook never sees. The pattern this replaced, `^Bearer [A-Za-z0-9_-]+$`,
// therefore answered 400 VALIDATION_ERROR to a *correct* key that happened to
// contain a character outside base64url: `openssl rand -base64 32` emits `+`,
// `/` and `=`, so which generator an operator reached for decided whether their
// deployment authenticated or reported its own request malformed. Verified
// against a running stack - `Bearer abc+def/ghi=` returned 400 while a merely
// wrong hex key returned 401, which is precisely backwards as a debugging
// signal.
//
// Widening the character class to cover base64, base64url and hex (plus `.`
// for JWT-shaped keys) was considered and rejected. It shrinks the blast radius
// without removing it: it still guesses what an operator's secret manager
// emits, and a guess wrong by one byte still tells someone holding the right
// credential that their request was malformed. There is no encoding this
// service needs the key to be in, so there is nothing for a pattern to assert.
//
// Removing it costs no security. The pattern was never the control - the
// constant-time comparison in `ServiceAuthService.isValid` is - and the hook
// already rejects anything that is not `Bearer <key>`, because `isValid`
// returns false when the prefix is absent. Dropping it makes the hook the sole
// author of every credential outcome, so absent, malformed and wrong all answer
// 401: one thing for a consumer to alert on. `description` and `examples` keep
// the OpenAPI documentation that the pattern was incidentally carrying.
export const SERVICE_API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  description:
    'NODE_SERVER_SERVICE_API_KEY sent as `Authorization: Bearer <key>`. Used by internal observability consumers (Monitoring Sidecar, Admin Server) to read this node’s status.',
  examples: ['Bearer some_service_key'],
});

export const SERVICE_API_KEY_SECURITY = [{ serviceApiKey: [] }];

// The 401 body is produced by `HttpError.unauthorized`, whose error code is the
// generic `UNAUTHORIZED`; the `Type.Literal` below is a JSON-schema `const`, and
// fast-json-stringify serializes `const` properties as the constant, so the
// response on the wire carries `INVALID_SERVICE_KEY`. Same arrangement as
// Session Manager - kept identical so both services document and emit the same
// code for the same failure.
export const INVALID_SERVICE_KEY_REPLY_SCHEMA = {
  401: Type.Object(
    {
      code: Type.Literal('INVALID_SERVICE_KEY'),
      message: Type.String({ description: 'Human-readable summary.' }),
    },
    {
      $id: 'InvalidServiceKeyReply',
      description:
        '401 emitted when NODE_SERVER_SERVICE_API_KEY is missing or invalid.',
    },
  ),
};
