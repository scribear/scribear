/**
 * HTTP base path for every Session Manager route. Route definitions prepend
 * this to their action paths so the reverse proxy layer (nginx) can map a
 * single prefix onto this service without per-route coordination.
 *
 * Example route URL: `${SESSION_MANAGER_BASE_PATH}/room-management/list-rooms`
 * resolves to `/api/session-manager/v1/room-management/list-rooms`.
 */
export const SESSION_MANAGER_BASE_PATH = '/api/session-manager/v1';
