import type {
  BaseRouteDefinition,
  BaseWebSocketRouteSchema,
} from '@scribear/base-schema';

import type {
  ConnectParams,
  WebSocketClientOptions,
} from './websocket-client.js';
import { WebSocketClient } from './websocket-client.js';

/**
 * Typed factory produced by {@link createWebSocketClient}. Each call creates
 * an independent {@link WebSocketClient} instance, so multiple simultaneous
 * connections to the same route are each started by a separate call.
 */
type WebSocketClientFactory<S extends BaseWebSocketRouteSchema> = (
  params: ConnectParams<S>,
) => WebSocketClient<S>;

/**
 * Creates a typed factory for a specific WebSocket endpoint.
 *
 * Each call to the returned factory constructs an independent
 * {@link WebSocketClient}, allowing multiple simultaneous connections to the
 * same route without creating separate API client instances.
 *
 * @param schema Route schema describing client/server messages and close codes.
 * @param route URL pattern for the WebSocket endpoint.
 * @param baseUrl Base URL of the server. HTTP schemes are translated to ws/wss.
 * @param options Shared connection settings applied to every instance produced
 *   by this factory (backoff, queue policy, handshake, etc.).
 */
function createWebSocketClient<S extends BaseWebSocketRouteSchema>(
  schema: S,
  route: BaseRouteDefinition,
  baseUrl: string,
  options?: Omit<
    WebSocketClientOptions<S>,
    'schema' | 'route' | 'baseUrl' | 'params'
  >,
): WebSocketClientFactory<S> {
  return (params: ConnectParams<S>): WebSocketClient<S> =>
    new WebSocketClient({ schema, route, baseUrl, params, ...options });
}

export { createWebSocketClient };
export type { WebSocketClientFactory };
