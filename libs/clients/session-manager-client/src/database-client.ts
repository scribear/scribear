import { createEndpointClient } from '@scribear/base-api-client';
import {
  SCHEMA_STATUS_ROUTE,
  SCHEMA_STATUS_SCHEMA,
} from '@scribear/session-manager-schema';

function createDatabaseClient(baseUrl: string) {
  return {
    schemaStatus: createEndpointClient(
      SCHEMA_STATUS_SCHEMA,
      SCHEMA_STATUS_ROUTE,
      baseUrl,
    ),
  };
}

export { createDatabaseClient };
