import { Type } from 'typebox';

// No `pattern`, for the reason set out in full in
// libs/schemas/node-server-schema/src/shared/security/service-api-key.ts:
// validation runs before the auth preHandler, so a pattern on this header
// answers 400 VALIDATION_ERROR to a *correct* key whose encoding it did not
// anticipate (`openssl rand -base64 32` emits `+`, `/` and `=`). Widening the
// class to base64/hex was rejected as still a guess about the operator's key
// generator. Nothing is lost: the pattern was never the security control - the
// constant-time compare in `AdminAuthService.isValid` is - and that method
// already rejects anything without the `Bearer ` prefix, so the hook alone
// decides every credential outcome and every one of them is a 401.
//
// Route schemas must also wrap this in `Type.Optional`. ADMIN_API_KEY is the
// public admin surface, so it is the one most likely to be probed by a caller
// that forgot the header entirely, and a required property here would answer
// that with 400 "must have required properties authorization" - a different
// status for the same class of mistake. See `adminApiKeyHook`, which treats
// absent and wrong identically.
export const ADMIN_API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  description:
    'ADMIN_API_KEY sent as `Authorization: Bearer <key>`. Grants access to all management endpoints.',
  examples: ['Bearer some_admin_key'],
});

export const ADMIN_API_KEY_SECURITY = [{ adminApiKey: [] }];

export const INVALID_ADMIN_KEY_REPLY_SCHEMA = {
  401: Type.Object(
    {
      code: Type.Literal('INVALID_ADMIN_KEY'),
      message: Type.String({ description: 'Human-readable summary.' }),
    },
    {
      $id: 'InvalidAdminKeyReply',
      description: '401 emitted when ADMIN_API_KEY is missing or invalid.',
    },
  ),
};
