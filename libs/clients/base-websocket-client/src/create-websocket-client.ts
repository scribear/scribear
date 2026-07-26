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
 * Per-connection options a factory call can override on top of the options
 * baked in at {@link createWebSocketClient} time. Same shape as the baked
 * options: anything except the four fields (`schema`, `route`, `baseUrl`,
 * `params`) that every instance shares or that the call itself supplies.
 *
 * Used for per-session concerns like an `onHandshake` that closes over
 * session-specific state — the orchestrator's upstream AUTH+CONFIG resend
 * (H2) is the motivating case.
 */
export type WebSocketClientFactoryOptions<S extends BaseWebSocketRouteSchema> =
  Omit<WebSocketClientOptions<S>, 'schema' | 'route' | 'baseUrl' | 'params'>;

/**
 * Typed factory produced by {@link createWebSocketClient}. Each call creates
 * an independent {@link WebSocketClient} instance, so multiple simultaneous
 * connections to the same route are each started by a separate call.
 *
 * The optional `options` argument overrides the factory's baked options for
 * this one instance (a per-call `onHandshake`, a different queue policy,
 * etc.); baked values apply for anything left unset.
 */
type WebSocketClientFactory<S extends BaseWebSocketRouteSchema> = (
  params: ConnectParams<S>,
  options?: WebSocketClientFactoryOptions<S>,
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
 *   by this factory (backoff, queue policy, handshake, etc.). A per-call
 *   `options` argument on the factory itself overrides these for one instance.
 */
function createWebSocketClient<S extends BaseWebSocketRouteSchema>(
  schema: S,
  route: BaseRouteDefinition,
  baseUrl: string,
  options?: WebSocketClientFactoryOptions<S>,
): WebSocketClientFactory<S> {
  return (
    params: ConnectParams<S>,
    perCallOptions?: WebSocketClientFactoryOptions<S>,
  ): WebSocketClient<S> =>
    new WebSocketClient({
      schema,
      route,
      baseUrl,
      params,
      ...options,
      ...perCallOptions,
    });
}

export { createWebSocketClient };
export type { WebSocketClientFactory };
