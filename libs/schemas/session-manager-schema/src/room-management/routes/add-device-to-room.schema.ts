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
import { ROOM_MANAGEMENT_TAG } from '#src/tags.js';

const ADD_DEVICE_TO_ROOM_SCHEMA = {
  description:
    'Attach a device to a room. If the device already belongs to another room it is first detached from that room in the same transaction. `asSource` is refused with 409 TOO_MANY_SOURCE_DEVICES when the room already has a source device - replacing a source is set-source-device’s job, so that a swap is always deliberate rather than a side effect of attaching a device. Refused with 409 when either side is part of the synthetic demo caption room, which has no audio path.',
  tags: [ROOM_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: Type.Optional(ADMIN_API_KEY_AUTH_HEADER_SCHEMA),
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    deviceUid: Type.String({ format: 'uuid' }),
    asSource: Type.Boolean({ default: false }),
  }),
  response: {
    204: Type.Null({ description: 'Device attached.' }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Union([
      Type.Object({
        code: Type.Literal('ROOM_NOT_FOUND'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('DEVICE_NOT_FOUND'),
        message: Type.String(),
      }),
    ]),
    409: Type.Union([
      Type.Object({
        code: Type.Literal('DEVICE_ALREADY_IN_ROOM'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('TOO_MANY_SOURCE_DEVICES'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('DEMO_ROOM_NOT_ASSIGNABLE'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('TEST_AUDIO_ROOM_NOT_ASSIGNABLE'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('TEST_AUDIO_DEVICE_NOT_ASSIGNABLE'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('CANARY_ROOM_NOT_ASSIGNABLE'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('CANARY_DEVICE_NOT_ASSIGNABLE'),
        message: Type.String(),
      }),
    ]),
  },
} satisfies BaseRouteSchema;

const ADD_DEVICE_TO_ROOM_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/room-management/add-device-to-room`,
};

export { ADD_DEVICE_TO_ROOM_SCHEMA, ADD_DEVICE_TO_ROOM_ROUTE };
