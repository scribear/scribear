import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  DEVICE_TOKEN_SECURITY,
  INVALID_DEVICE_TOKEN_REPLY_SCHEMA,
} from '#src/shared/security/device-token.js';
import { ROOM_MANAGEMENT_TAG } from '#src/tags.js';

import { SELF_ROOM_SCHEMA } from '../entities/room.schema.js';

const GET_MY_ROOM_SCHEMA = {
  description:
    'Return the room the calling device belongs to. Authenticated via the `DEVICE_TOKEN` cookie. 404 if the device is not currently a member of any room.',
  tags: [ROOM_MANAGEMENT_TAG],
  security: DEVICE_TOKEN_SECURITY,
  response: {
    200: SELF_ROOM_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_DEVICE_TOKEN_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('DEVICE_NOT_IN_ROOM'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const GET_MY_ROOM_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/room-management/get-my-room`,
};

export { GET_MY_ROOM_SCHEMA, GET_MY_ROOM_ROUTE };
