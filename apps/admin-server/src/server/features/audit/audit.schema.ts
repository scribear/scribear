import { Type } from 'typebox';

import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

export const LIST_AUDIT_SCHEMA = {
  querystring: Type.Object({
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
    ),
  }),
};

export const LIST_AUDIT_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/audit`,
};
