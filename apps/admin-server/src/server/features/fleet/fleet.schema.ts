import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

export const FLEET_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/fleet`,
};

export const FLEET_STREAM_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/fleet/stream`,
};
