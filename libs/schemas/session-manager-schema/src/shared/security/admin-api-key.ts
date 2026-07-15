import { Type } from 'typebox';

export const ADMIN_API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  pattern: '^Bearer [A-Za-z0-9_-]+$',
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
