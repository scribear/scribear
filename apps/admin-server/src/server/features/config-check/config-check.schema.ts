import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

export const CONFIG_CHECK_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/config-check`,
};
