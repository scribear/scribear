import type { TSchema } from 'typebox';

import type { BaseRouteSchema } from './base-route-schema.js';

/**
 * Schema definition for a long-poll endpoint. Extends {@link BaseRouteSchema}
 * with the constraint that both a 200 (new data available) and 204 (no change
 * within timeout, re-poll immediately) response must be declared.
 *
 * The version cursor is passed by the client as a querystring parameter and
 * updated from the 200 response body on each successful poll. The client
 * library handles cursor bookkeeping - `versionParam` and `versionResponseKey`
 * on `LongPollClientOptions` tell it which field to read and write.
 */
type BaseLongPollRouteSchema = BaseRouteSchema & {
  response: {
    200: TSchema;
    204: TSchema;
  };
};

export type { BaseLongPollRouteSchema };
