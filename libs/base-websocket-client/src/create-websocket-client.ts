import WebSocket from 'isomorphic-ws';
import { type Static, type TSchema } from 'typebox';

import type {
  BaseRouteDefinition,
  BaseWebSocketRouteSchema,
} from '@scribear/base-schema';

import { buildWsUrl } from './build-ws-url.js';
import { ConnectionError } from './errors.js';
import { WebSocketClient } from './websocket-client.js';

/**
 * Extracts a typed params object from a WebSocket route schema, including only the
 * keys (querystring, params, headers) that are defined in the schema.
 */
type InputKey = 'querystring' | 'params' | 'headers';
type WebSocketConnectParams<S extends BaseWebSocketRouteSchema> = {
  [K in InputKey as undefined extends S[K] ? never : K]: S[K] extends TSchema
    ? Static<S[K]>
    : never;
};

/**
 * Result tuple returned by the connect function.
 * Either a connected client or a connection error
 */
type WebSocketConnectResult<S extends BaseWebSocketRouteSchema> =
  | [client: WebSocketClient<S>, error: null]
  | [client: null, error: ConnectionError];

/**
 * Creates a typed WebSocket connect function for a specific route.
 *
 * The returned function establishes a connection, validates server messages
 * against the TypeBox schema, and provides fully typed send/event APIs.
 *
 * @param schema - The BaseWebSocketRouteSchema for this endpoint.
 * @param route - The BaseRouteDefinition specifying the URL pattern.
 * @param baseUrl - Base URL of the server (e.g. 'http://localhost:3000').
 * @returns A typed async function that connects and returns a WebSocketClient.
 */
function createWebSocketClient<S extends BaseWebSocketRouteSchema>(
  schema: S,
  route: BaseRouteDefinition,
  baseUrl: string,
): (params: WebSocketConnectParams<S>) => Promise<WebSocketConnectResult<S>> {
  return function (
    params: WebSocketConnectParams<S>,
  ): Promise<WebSocketConnectResult<S>> {
    const typedParams = params as {
      querystring?: Record<string, string>;
      params?: Record<string, string>;
      headers?: Record<string, string>;
    };

    const url = buildWsUrl(
      baseUrl,
      route.url,
      typedParams.params,
      typedParams.querystring,
    );

    return new Promise((resolve) => {
      const ws = new WebSocket(url, { headers: typedParams.headers });

      ws.onopen = () => {
        ws.onopen = null;
        ws.onerror = null;
        const client = new WebSocketClient(ws, schema);
        resolve([client, null]);
      };

      ws.onerror = (event) => {
        ws.onopen = null;
        ws.onerror = null;
        resolve([null, new ConnectionError(event.error)]);
      };
    });
  };
}

export { createWebSocketClient };
export type { WebSocketConnectParams, WebSocketConnectResult };
