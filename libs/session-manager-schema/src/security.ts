import { Type } from 'typebox';

import type { BaseSecurityDefinition } from '@scribear/base-schema';

export const API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  pattern: '^Bearer [A-Za-z0-9_-]+$',
  description: 'API key authentication header.',
  examples: ['Bearer some_api_key'],
});

export const OPENAPI_SECURITY_SCHEMES = {
  apiKeyAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'API key',
    description: 'API key authentication header.',
  },
} satisfies BaseSecurityDefinition;

export const API_KEY_AUTH_SECURITY = [{ apiKeyAuth: [] }];
