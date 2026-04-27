import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  ADMIN_API_KEY_SECURITY,
  INVALID_ADMIN_KEY_REPLY_SCHEMA,
} from '#src/shared/security/admin-api-key.js';
import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';
import { SCHEDULE_MANAGEMENT_TAG } from '#src/tags.js';

import { SESSION_SCHEMA } from '../entities/session.schema.js';

const CREATE_ON_DEMAND_SESSION_SCHEMA = {
  description:
    'Create an on-demand session that begins immediately. A currently-active AUTO session is preempted; any other active non-AUTO session causes a 409.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    joinCodeScopes: Type.Array(SESSION_SCOPE_SCHEMA),
    transcriptionProviderId: Type.String(),
    transcriptionStreamConfig: Type.Unknown(),
  }),
  response: {
    201: SESSION_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('ROOM_NOT_FOUND'),
      message: Type.String(),
    }),
    409: Type.Object({
      code: Type.Literal('ANOTHER_SESSION_ACTIVE'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const CREATE_ON_DEMAND_SESSION_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/create-on-demand-session`,
};

export { CREATE_ON_DEMAND_SESSION_SCHEMA, CREATE_ON_DEMAND_SESSION_ROUTE };
