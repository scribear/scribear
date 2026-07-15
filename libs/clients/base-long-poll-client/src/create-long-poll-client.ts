import type {
  BaseLongPollRouteSchema,
  BaseRouteDefinition,
} from '@scribear/base-schema';

import type {
  ConnectParams,
  LongPollClientOptions,
} from './long-poll-client.js';
import { LongPollClient } from './long-poll-client.js';

/**
 * Typed factory produced by {@link createLongPollClient}. Each call creates an
 * independent {@link LongPollClient} instance, so multiple simultaneous polls
 * against the same route are each started by a separate call.
 */
type LongPollClientFactory<S extends BaseLongPollRouteSchema> = (
  params: ConnectParams<S>,
) => LongPollClient<S>;

/**
 * Creates a typed factory for a specific long-poll endpoint.
 *
 * Each call to the returned factory constructs an independent
 * {@link LongPollClient}, allowing multiple simultaneous polls against the
 * same route without creating separate client instances.
 *
 * @param schema Route schema describing the 200 response shape.
 * @param route URL pattern for the long-poll endpoint.
 * @param baseUrl Base URL of the server.
 * @param versionParam Querystring parameter name for the cursor (e.g. `'sinceVersion'`).
 * @param versionResponseKey Key in the response body carrying the new cursor value.
 * @param options Shared connection settings applied to every instance produced
 *   by this factory (headers, backoff, requestInit, initialVersion, etc.).
 */
function createLongPollClient<S extends BaseLongPollRouteSchema>(
  schema: S,
  route: BaseRouteDefinition,
  baseUrl: string,
  versionParam: string,
  versionResponseKey: string,
  options?: Omit<
    LongPollClientOptions<S>,
    | 'schema'
    | 'route'
    | 'baseUrl'
    | 'params'
    | 'versionParam'
    | 'versionResponseKey'
  >,
): LongPollClientFactory<S> {
  return (params: ConnectParams<S>): LongPollClient<S> =>
    new LongPollClient({
      schema,
      route,
      baseUrl,
      params,
      versionParam,
      versionResponseKey,
      ...options,
    });
}

export { createLongPollClient };
export type { LongPollClientFactory };
