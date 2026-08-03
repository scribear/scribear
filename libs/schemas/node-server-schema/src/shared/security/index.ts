import type { BaseSecurityDefinition } from '@scribear/base-schema';

export * from './service-api-key.js';

export const OPENAPI_SECURITY_SCHEMES = {
  serviceApiKey: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'API key',
    description:
      'NODE_SERVER_SERVICE_API_KEY. Authorizes inbound service-to-service calls (e.g. the Monitoring Sidecar reading the status endpoint). Distinct from the SESSION_MANAGER_SERVICE_API_KEY this service presents outbound.',
  },
} satisfies BaseSecurityDefinition;
