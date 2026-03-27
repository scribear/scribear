import { createEndpointClient } from '@scribear/base-api-client';
import {
  ACTIVATE_DEVICE_ROUTE,
  ACTIVATE_DEVICE_SCHEMA,
  CREATE_SESSION_ROUTE,
  CREATE_SESSION_SCHEMA,
  DEVICE_SESSION_EVENTS_ROUTE,
  DEVICE_SESSION_EVENTS_SCHEMA,
  HEALTHCHECK_ROUTE,
  HEALTHCHECK_SCHEMA,
  REGISTER_DEVICE_ROUTE,
  REGISTER_DEVICE_SCHEMA,
  SESSION_JOIN_CODE_AUTH_ROUTE,
  SESSION_JOIN_CODE_AUTH_SCHEMA,
  SOURCE_DEVICE_SESSION_AUTH_ROUTE,
  SOURCE_DEVICE_SESSION_AUTH_SCHEMA,
} from '@scribear/session-manager-schema';

/**
 * Creates a typed API client for the session manager service.
 *
 * @param baseUrl - Base URL of the session manager API (e.g. "http://localhost:3000").
 * @returns An object containing typed endpoint functions for each session manager route.
 */
function createSessionManagerClient(baseUrl: string) {
  return {
    healthcheck: createEndpointClient(
      HEALTHCHECK_SCHEMA,
      HEALTHCHECK_ROUTE,
      baseUrl,
    ),
    registerDevice: createEndpointClient(
      REGISTER_DEVICE_SCHEMA,
      REGISTER_DEVICE_ROUTE,
      baseUrl,
    ),
    activateDevice: createEndpointClient(
      ACTIVATE_DEVICE_SCHEMA,
      ACTIVATE_DEVICE_ROUTE,
      baseUrl,
    ),
    createSession: createEndpointClient(
      CREATE_SESSION_SCHEMA,
      CREATE_SESSION_ROUTE,
      baseUrl,
    ),
    sessionJoinCodeAuth: createEndpointClient(
      SESSION_JOIN_CODE_AUTH_SCHEMA,
      SESSION_JOIN_CODE_AUTH_ROUTE,
      baseUrl,
    ),
    sourceDeviceSessionAuth: createEndpointClient(
      SOURCE_DEVICE_SESSION_AUTH_SCHEMA,
      SOURCE_DEVICE_SESSION_AUTH_ROUTE,
      baseUrl,
    ),
    getDeviceSessionEvents: createEndpointClient(
      DEVICE_SESSION_EVENTS_SCHEMA,
      DEVICE_SESSION_EVENTS_ROUTE,
      baseUrl,
    ),
  };
}

export { createSessionManagerClient };
