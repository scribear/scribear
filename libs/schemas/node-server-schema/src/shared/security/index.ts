import type { BaseSecurityDefinition } from '@scribear/base-schema';

export * from './session-token.js';

export const OPENAPI_SECURITY_SCHEMES = {
  sessionToken: {
    type: 'apiKey',
    in: 'header',
    name: 'sessionToken',
    description:
      'Short-lived session token issued by Session Manager. Presented on the WebSocket handshake via an `auth` client message rather than an HTTP header so it does not appear in URLs or proxy logs.',
  },
} satisfies BaseSecurityDefinition;
