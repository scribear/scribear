import type { BaseSecurityDefinition } from '@scribear/base-schema';

import { DEVICE_TOKEN_COOKIE_NAME } from './device-token.js';

export * from './admin-api-key.js';
export * from './device-token.js';
export * from './service-api-key.js';

export const OPENAPI_SECURITY_SCHEMES = {
  adminApiKey: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'API key',
    description:
      'ADMIN_API_KEY. Authorizes all management endpoints. Presented as `Authorization: Bearer <key>`.',
  },
  serviceApiKey: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'API key',
    description:
      'SESSION_MANAGER_SERVICE_API_KEY. Authorizes internal service-to-service calls (e.g. Session Stream Server consuming SSE).',
  },
  deviceToken: {
    type: 'apiKey',
    in: 'cookie',
    name: DEVICE_TOKEN_COOKIE_NAME,
    description:
      'HTTP-only `DEVICE_TOKEN` cookie in the format `{deviceUid}:{secret}`. Set by the activate-device endpoint and refreshed by every subsequent authenticated call.',
  },
} satisfies BaseSecurityDefinition;

/**
 * Union of ADMIN + SERVICE + DEVICE auth. Endpoints that accept any of the
 * three should use this as their `security` value.
 */
export const ANY_AUTH_SECURITY = [
  { adminApiKey: [] },
  { serviceApiKey: [] },
  { deviceToken: [] },
];

/**
 * ADMIN + SERVICE (no device). Used by service-to-service channels like
 * `session-config-stream` that must not accept device tokens.
 */
export const ADMIN_OR_SERVICE_SECURITY = [
  { adminApiKey: [] },
  { serviceApiKey: [] },
];
