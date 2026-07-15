import { Type } from 'typebox';

export const SERVICE_API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  pattern: '^Bearer [A-Za-z0-9_-]+$',
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
