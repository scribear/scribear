/**
 * API URL configuration for backend services.
 * Uses Vite env vars with sensible local development defaults.
 *
 * Set VITE_SESSION_MANAGER_URL and VITE_NODE_SERVER_URL in .env to override.
 */

export const SESSION_MANAGER_URL: string =
  (import.meta.env['VITE_SESSION_MANAGER_URL'] as string | undefined) ??
  'http://localhost:8000';

export const NODE_SERVER_URL: string =
  (import.meta.env['VITE_NODE_SERVER_URL'] as string | undefined) ??
  'http://localhost:8001';

/** Derive WebSocket base URL from HTTP node-server URL */
export const NODE_SERVER_WS_URL = NODE_SERVER_URL.replace(/^http/, 'ws');
