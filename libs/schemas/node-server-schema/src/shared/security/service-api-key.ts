import { Type } from 'typebox';

export const SERVICE_API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  pattern: '^Bearer [A-Za-z0-9_-]+$',
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
