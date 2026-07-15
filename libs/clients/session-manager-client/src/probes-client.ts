import { createEndpointClient } from '@scribear/base-api-client';
import {
  LIVENESS_ROUTE,
  LIVENESS_SCHEMA,
  READINESS_ROUTE,
  READINESS_SCHEMA,
} from '@scribear/session-manager-schema';

function createProbesClient(baseUrl: string) {
  return {
    liveness: createEndpointClient(LIVENESS_SCHEMA, LIVENESS_ROUTE, baseUrl),
    readiness: createEndpointClient(READINESS_SCHEMA, READINESS_ROUTE, baseUrl),
  };
}

export { createProbesClient };
