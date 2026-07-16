import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

export const HEALTH_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/health`,
};
