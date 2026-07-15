/**
 * HTTP base path for every Node Server route. Route definitions prepend this
 * to their action paths so the reverse proxy layer (nginx) can map a single
 * prefix onto this service without per-route coordination.
 *
 * Example route URL: `${NODE_SERVER_BASE_PATH}/transcription-stream` resolves
 * to `/api/node-server/v1/transcription-stream`.
 */
export const NODE_SERVER_BASE_PATH = '/api/node-server/v1';
