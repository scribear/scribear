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
import { DEMO_ROOM_TAG } from '#src/tags.js';

/**
 * Operational status of the demo caption room, for the admin console. Reports
 * whether the feature is switched on, whether the seeded session is currently
 * joinable, and — when it is — a currently-valid join code so the console can
 * build a one-click "open live captions" link.
 *
 * `joinCode` is intentionally exposed here (unlike the device-facing
 * `fetch-join-code` route, which requires a device token) because this route is
 * admin-key protected — only an authenticated operator ever sees it. When
 * `DEMO_ROOM_ENABLED=false` the feature is off and this route returns
 * `enabled: false` with a `null` code.
 */
export const DEMO_ROOM_STATUS_RESPONSE_SCHEMA = Type.Object(
  {
    enabled: Type.Boolean({
      description: 'Whether `DEMO_ROOM_ENABLED` is set on the Session Manager.',
    }),
    sessionUid: Type.String({
      format: 'uuid',
      description: 'The configured `DEMO_SESSION_UID` the demo captions use.',
    }),
    active: Type.Boolean({
      description:
        'Whether the seeded demo session exists and is currently within its ' +
        'effective window — i.e. a join code will exchange successfully.',
    }),
    roomName: Type.Union([Type.String(), Type.Null()], {
      description: 'Display name of the demo room, or null when not seeded.',
    }),
    joinCode: Type.Union([Type.String(), Type.Null()], {
      description:
        'A currently-valid join code for the demo session, or null when the ' +
        'feature is off or the session is not active. Rotates on a ~5 minute ' +
        'window; minted on demand.',
    }),
  },
  { $id: 'DemoRoomStatus' },
);

export const DEMO_ROOM_STATUS_SCHEMA = {
  description:
    'Report whether the demo caption room is enabled and joinable, with a ' +
    'currently-valid join code when it is.',
  tags: [DEMO_ROOM_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: Type.Optional(ADMIN_API_KEY_AUTH_HEADER_SCHEMA),
  }),
  response: {
    200: DEMO_ROOM_STATUS_RESPONSE_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

export const DEMO_ROOM_STATUS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/demo-room/status`,
};
