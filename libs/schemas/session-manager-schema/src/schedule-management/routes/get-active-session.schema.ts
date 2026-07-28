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
import { SCHEDULE_MANAGEMENT_TAG } from '#src/tags.js';

import { SESSION_SCHEMA } from '../entities/session.schema.js';

/**
 * The room's currently-active session: effective start ≤ now and (effective
 * end > now or effective end is null). Null body (200) when no session is
 * active, so a caller can distinguish "room has no active session" from "room
 * not found" (404) without inspecting the error code.
 */
const GET_ACTIVE_SESSION_SCHEMA = {
  description:
    'Fetch the currently-active session for a room, of any type. Returns null when no session is active.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: Type.Optional(ADMIN_API_KEY_AUTH_HEADER_SCHEMA),
  }),
  params: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    200: Type.Union([SESSION_SCHEMA, Type.Null()]),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('ROOM_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const GET_ACTIVE_SESSION_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/get-active-session/:roomUid`,
};

export { GET_ACTIVE_SESSION_ROUTE, GET_ACTIVE_SESSION_SCHEMA };
