import { Type } from 'typebox';
import type { Static } from 'typebox';

import {
  STATUS_PROCESS_SCHEMA,
  STATUS_SESSION_SCHEMA,
} from '@scribear/node-server-schema';

import { SNAPSHOT_ENVELOPE_PROPERTIES } from './snapshot-envelope.schema.js';
import { type SnapshotParseResult, parseSnapshot } from './snapshot-parse.js';

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
 * Value of a session snapshot key. @see {@link SESSION_SNAPSHOT_SCHEMA}
 *
 * Publishers should type the record they build as this rather than assembling
 * it loosely: a field added to `/status` then fails to compile here until it is
 * carried through, which is the whole point of composing the two schemas.
 */
export type SessionSnapshot = Static<typeof SESSION_SNAPSHOT_SCHEMA>;

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

/** Value of a Node Server instance key. @see {@link NODE_SNAPSHOT_SCHEMA} */
export type NodeSnapshot = Static<typeof NODE_SNAPSHOT_SCHEMA>;

/**
 * Validating parser for a session key's value.
 *
 * Lives beside the schema for the same reason `parseSessionAudioSnapshot` does:
 * enforcement belongs with the definition, not re-implemented per consumer.
 *
 * The reader **drops** a value this rejects - admin-server's
 * `FleetTelemetryService._readIndexed`, which logs one throttled warn per index
 * and serves the rest. There is no log-only mode any more: this schema spent a
 * release validating in one because it had never been checked against its
 * publisher, and that is no longer the case. `node-server`'s publisher declares
 * `const record: SessionSnapshot` against this very type, so the compiler holds
 * the shape, and its integration suite now drives the real publisher into a
 * real Redis and parses the bytes back
 * (`publisher-schema-crosscheck.test.ts`).
 *
 * Dropping means the session vanishes from the fleet view entirely, which is
 * why any field added to this shape after a publisher has shipped must be
 * `Type.Optional` - see `audioFramesReceived` in `STATUS_SESSION_SCHEMA` and
 * `binaryBeforeAuthDropsTotal` in `STATUS_PROCESS_SCHEMA`. A mismatch here is
 * far more likely to be a stale deployed version mid-rolling-deploy than a
 * mirror that drifted, and a required new field would blank a perfectly
 * healthy older instance for the length of that deploy. The compiler pins the
 * shape within one build; it says nothing about two versions running at once.
 */
export function parseSessionSnapshot(
  raw: string,
): SnapshotParseResult<SessionSnapshot> {
  return parseSnapshot(SESSION_SNAPSHOT_SCHEMA, raw);
}

/**
 * Validating parser for a node-instance key's value. Same standing as
 * {@link parseSessionSnapshot}: compiler-backed at the publisher
 * (`const instance: NodeSnapshot`), pinned end to end by node-server's
 * `publisher-schema-crosscheck.test.ts`, and dropped by the reader on a
 * mismatch rather than served unvalidated.
 */
export function parseNodeSnapshot(
  raw: string,
): SnapshotParseResult<NodeSnapshot> {
  return parseSnapshot(NODE_SNAPSHOT_SCHEMA, raw);
}
