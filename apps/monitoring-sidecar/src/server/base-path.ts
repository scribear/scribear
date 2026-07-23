/**
 * Base path for every monitoring sidecar route.
 *
 * The sidecar sits on the `backend` compose network only and is not exposed
 * through nginx: its snapshot is intended to be read by admin-server (which
 * already holds admin auth) rather than by browsers directly. The versioned
 * prefix matches the convention used by every other Node service.
 */
export const MONITORING_BASE_PATH = '/api/monitoring/v1';
