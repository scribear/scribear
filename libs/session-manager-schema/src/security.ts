import { Type } from 'typebox';

import type { BaseSecurityDefinition } from '@scribear/base-schema';

export const API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  pattern: '^Bearer [A-Za-z0-9_-]+$',
  description: 'API key authentication header.',
  examples: ['Bearer some_api_key'],
});

export const DEVICE_COOKIE_NAME = 'device_token';

export const DEVICE_COOKIE_SCHEMA = Type.String({
  description:
    'Device token cookie set after device activation. Note, the activate device endpoint is needed to set cookie in Swagger UI',
});

export const OPENAPI_SECURITY_SCHEMES = {
  apiKeyAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'API key',
    description: 'API key authentication header.',
  },
  deviceCookieAuth: {
    type: 'apiKey',
    in: 'cookie',
    name: DEVICE_COOKIE_NAME,
    description: 'Device token cookie set after device activation.',
  },
} satisfies BaseSecurityDefinition;

export const API_KEY_AUTH_SECURITY = [{ apiKeyAuth: [] }];
export const DEVICE_COOKIE_AUTH_SECURITY = [{ deviceCookieAuth: [] }];
