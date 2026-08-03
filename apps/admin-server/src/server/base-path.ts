/**
 * Base path for every admin BFF route. nginx maps `location /api/admin/` to
 * this service (preserving the full path), and the SPA calls `/api/admin/v1/*`.
 */
export const ADMIN_BASE_PATH = '/api/admin/v1';
