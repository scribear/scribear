import { Type } from 'typebox';

import {
  STATUS_PROCESS_SCHEMA,
  STATUS_SESSION_SCHEMA,
} from '@scribear/node-server-schema';

import { SNAPSHOT_ENVELOPE_PROPERTIES } from './snapshot-envelope.schema.js';

/**
 * One live session as published to the backplane.
 *
 * The session fields are the Node Server `/status` session record verbatim, so
 * a consumer that renders one renders the other. What is added is only what an
 * aggregated view needs and a single process could leave implicit: which
 * instance is reporting, and when.
 */
export const SESSION_SNAPSHOT_SCHEMA = Type.Object({
  ...STATUS_SESSION_SCHEMA.properties,
  ...SNAPSHOT_ENVELOPE_PROPERTIES,
  nodeInstanceId: Type.String({
    description:
      'The Node Server instance that owns this session’s upstream. Matches the route key and identifies which instance to interrogate about the room.',
  }),
  processUid: Type.String({
    format: 'uuid',
    description:
      'Process instance of the owning Node Server, regenerated on every boot. `nodeInstanceId` defaults to a hostname and so survives a restart; this does not, which is what lets a consumer tell a restart from a lull rather than reading the counters back to zero as a negative rate.',
  }),
});

/**
 * One Node Server instance as published to the backplane.
 *
 * The process fields are its `/status` body minus the session list, which
 * travels as its own records. `summary.activeSessionCount` is therefore the
 * authoritative count for this instance, and a reader seeing fewer session
 * records than that is looking at a partially expired or partially written
 * fleet, not at an instance that lost sessions.
 */
export const NODE_SNAPSHOT_SCHEMA = Type.Object({
  ...STATUS_PROCESS_SCHEMA.properties,
  ...SNAPSHOT_ENVELOPE_PROPERTIES,
  nodeInstanceId: Type.String({
    description:
      'Stable identity of this instance across restarts - a hostname or pod name. `processUid` distinguishes runs of it.',
  }),
});
