import { Type } from 'typebox';

// No `pattern`, for the reason set out in full in
// libs/schemas/node-server-schema/src/shared/security/service-api-key.ts:
// validation runs before the auth preHandler, so a pattern on this header
// answers 400 VALIDATION_ERROR to a *correct* key whose encoding it did not
// anticipate (`openssl rand -base64 32` emits `+`, `/` and `=`). Widening the
// class to base64/hex was rejected as still a guess about the operator's key
// generator. Nothing is lost: the pattern was never the security control - the
// constant-time compare in `ServiceAuthService.isValid` is - and that method
// already rejects anything without the `Bearer ` prefix, so the hook alone
// decides every credential outcome and every one of them is a 401.
export const SERVICE_API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  description:
    'SESSION_MANAGER_SERVICE_API_KEY sent as `Authorization: Bearer <key>`. Used by sibling services (Session Stream Server) to consume internal APIs.',
  examples: ['Bearer some_service_key'],
});

export const SERVICE_API_KEY_SECURITY = [{ serviceApiKey: [] }];

export const INVALID_SERVICE_KEY_REPLY_SCHEMA = {
  401: Type.Object(
    {
      code: Type.Literal('INVALID_SERVICE_KEY'),
      message: Type.String({ description: 'Human-readable summary.' }),
    },
    {
      $id: 'InvalidServiceKeyReply',
      description: '401 emitted when ADMIN_API_KEY is missing or invalid.',
    },
  ),
};
