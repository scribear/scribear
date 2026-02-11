import { Type } from 'typebox';

import type { BaseSecurityDefinition } from '@scribear/base-schema';

export const API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  pattern: '^API-KEY [A-Za-z0-9_-]+$',
  description:
    'API key authentication header. Format: API-KEY <your-api-key>. Do not use this parameter directly in Swagger Web UI, use the Authorize button at the top of the page or lock icon in the corner of this endpoint instead.',
  examples: ['API-KEY some_api_key'],
});

export const KIOSK_SECRET_AUTH_HEADER_SCHEMA = Type.String({
  pattern: '^KIOSK-SECRET [A-Za-z0-9_-]+$',
  description:
    'Kiosk secret authentication header. Format: KIOSK-SECRET <your-kiosk-secret>. Do not use this parameter directly in Swagger Web UI, use the Authorize button at the top of the page or lock icon in the corner of this endpoint instead.',
  examples: ['KIOSK-SECRET some_kiosk_secret'],
});

export const OPENAPI_SECURITY_SCHEMES = {
  apiKeyAuth: {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description: 'API key authentication. Format: `API-KEY <your-api-key>`',
  },
  kioskSecretAuth: {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description:
      'Kiosk secret authentication. Format: `KIOSK-SECRET <your-kiosk-secret>`',
  },
} satisfies BaseSecurityDefinition;

export const API_KEY_AUTH_SECURITY = { apiKeyAuth: [] };
export const KIOSK_SECRET_AUTH_SECURITY = { kioskSecretAuth: [] };
