import { Type } from 'typebox';

import type { BaseSecurityDefinition } from '@scribear/base-schema';

export const API_KEY_AUTH_HEADER_SCHEMA = Type.String({
  pattern: '^API-KEY [A-Za-z0-9_-]+$',
  description:
    'API key authentication header. Format: API-KEY <your-api-key>. Do not use this parameter directly in Swagger Web UI, use the Authorize button at the top of the page or lock icon in the corner of this endpoint instead.',
  examples: ['API-KEY some_api_key'],
});

export const KIOSK_TOKEN_AUTH_HEADER_SCHEMA = Type.String({
  pattern: '^KIOSK-TOKEN [A-Za-z0-9+/=]+$',
  description:
    'Kiosk secret authentication header. Format: KIOSK-TOKEN <base64-encoded-token>. The token is provided when registering a kiosk. Do not use this parameter directly in Swagger Web UI, use the Authorize button at the top of the page or lock icon in the corner of this endpoint instead.',
  examples: ['KIOSK-TOKEN dXVpZDpzZWNyZXQ='],
});

export const OPENAPI_SECURITY_SCHEMES = {
  apiKeyAuth: {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description: 'API key authentication. Format: `API-KEY <your-api-key>`',
  },
  kioskTokenAuth: {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description:
      'Kiosk secret authentication. Format: `KIOSK-TOKEN <base64-encoded-token>`',
  },
} satisfies BaseSecurityDefinition;

export const API_KEY_AUTH_SECURITY = { apiKeyAuth: [] };
export const KIOSK_TOKEN_AUTH_SECURITY = { kioskTokenAuth: [] };
