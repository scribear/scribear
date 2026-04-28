import { createEndpointClient } from '@scribear/base-api-client';
import {
  EXCHANGE_DEVICE_TOKEN_ROUTE,
  EXCHANGE_DEVICE_TOKEN_SCHEMA,
  EXCHANGE_JOIN_CODE_ROUTE,
  EXCHANGE_JOIN_CODE_SCHEMA,
  FETCH_JOIN_CODE_ROUTE,
  FETCH_JOIN_CODE_SCHEMA,
  REFRESH_SESSION_TOKEN_ROUTE,
  REFRESH_SESSION_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

function createSessionAuthClient(baseUrl: string) {
  return {
    fetchJoinCode: createEndpointClient(
      FETCH_JOIN_CODE_SCHEMA,
      FETCH_JOIN_CODE_ROUTE,
      baseUrl,
    ),
    exchangeDeviceToken: createEndpointClient(
      EXCHANGE_DEVICE_TOKEN_SCHEMA,
      EXCHANGE_DEVICE_TOKEN_ROUTE,
      baseUrl,
    ),
    exchangeJoinCode: createEndpointClient(
      EXCHANGE_JOIN_CODE_SCHEMA,
      EXCHANGE_JOIN_CODE_ROUTE,
      baseUrl,
    ),
    refreshSessionToken: createEndpointClient(
      REFRESH_SESSION_TOKEN_SCHEMA,
      REFRESH_SESSION_TOKEN_ROUTE,
      baseUrl,
    ),
  };
}

export { createSessionAuthClient };
