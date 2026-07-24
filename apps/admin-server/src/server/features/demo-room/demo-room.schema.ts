import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

export const DEMO_ROOM_STATUS_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/demo-room/status`,
};
