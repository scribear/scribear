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
} from '#src/security/admin-api-key.js';
import { paginatedQuerySchema } from '#src/shared/entities/pagination.schema.js';
import { DEVICE_MANAGEMENT_TAG } from '#src/tags.js';

import { DEVICE_SCHEMA } from '../entities/device.schema.js';

const LIST_DEVICES_SCHEMA = {
  description:
    'List devices, optionally filtered by fuzzy name search, active state, or room membership. Results are paginated.',
  tags: [DEVICE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  querystring: paginatedQuerySchema({
    search: Type.Optional(
      Type.String({
        description:
          'Fuzzy substring match on device name via trigram similarity.',
      }),
    ),
    active: Type.Optional(
      Type.Boolean({
        description:
          'Filter by activation state. Omit to include both activated and pending devices.',
      }),
    ),
    roomUid: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Restrict results to devices attached to this room. Pass the empty string to return only unattached devices.',
      }),
    ),
  }),
  response: {
    200: Type.Object(
      {
        items: Type.Array(DEVICE_SCHEMA),
        nextCursor: Type.Optional(Type.String()),
      },
      { description: 'Paginated devices matching the filters.' },
    ),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

const LIST_DEVICES_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/device-management/list-devices`,
};

export { LIST_DEVICES_SCHEMA, LIST_DEVICES_ROUTE };
