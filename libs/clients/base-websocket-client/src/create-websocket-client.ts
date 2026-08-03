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
 * Connection settings a caller may supply, either baked into a factory at
 * {@link createWebSocketClient} time or overridden per factory call. Everything
 * {@link WebSocketClientOptions} accepts except the four fields that identify
 * the connection itself, which the factory always supplies.
 *
 * Named rather than inlined because it appears in three positions that must
 * stay identical, and because callers building their own options object want
 * something to annotate it with.
 */
export type WebSocketClientFactoryOptions<S extends BaseWebSocketRouteSchema> =
  Omit<WebSocketClientOptions<S>, 'schema' | 'route' | 'baseUrl' | 'params'>;

/**
 * Typed factory produced by {@link createWebSocketClient}. Each call creates
 * an independent {@link WebSocketClient} instance, so multiple simultaneous
 * connections to the same route are each started by a separate call.
 *
 * The optional second argument overrides the factory's baked options for this
 * one instance; anything left unset keeps the baked value.
 */
type WebSocketClientFactory<S extends BaseWebSocketRouteSchema> = (
  params: ConnectParams<S>,
  overrides?: WebSocketClientFactoryOptions<S>,
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
 *   by this factory (backoff, queue policy, handshake, etc.). Each call to the
 *   factory may override any of them, which is what makes a per-connection
 *   `onHandshake` possible: a handshake that has to replay per-session
 *   credentials or config cannot be baked into a factory shared by every
 *   session, but it is exactly the handshake that must survive a reconnect.
 */
function createWebSocketClient<S extends BaseWebSocketRouteSchema>(
  schema: S,
  route: BaseRouteDefinition,
  baseUrl: string,
  options?: WebSocketClientFactoryOptions<S>,
): WebSocketClientFactory<S> {
  return (
    params: ConnectParams<S>,
    overrides?: WebSocketClientFactoryOptions<S>,
  ): WebSocketClient<S> =>
    new WebSocketClient({
      schema,
      route,
      baseUrl,
      params,
      ...options,
      ...overrides,
    });
}

export { createWebSocketClient };
export type { WebSocketClientFactory };
