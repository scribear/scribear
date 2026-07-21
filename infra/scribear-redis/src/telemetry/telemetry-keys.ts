/**
 * Key layout for the fleet telemetry backplane (B1.7).
 *
 * Every key lives under one namespace so a Redis shared with anything else
 * stays separable, and so the whole telemetry plane can be dropped with a
 * single `SCAN`/`DEL` sweep. The `v1` segment is a schema version: change the
 * meaning or shape of any payload below in a way an old reader would
 * misinterpret and bump it, rather than editing in place. Publishers and
 * readers then simply stop seeing each other, which is a visible outage, where
 * a silently reinterpreted payload is a wrong dashboard.
 *
 * The pattern throughout is snapshot-plus-index:
 *
 * - A **snapshot key** holds the current state of one thing as JSON and is
 *   rewritten every heartbeat with a TTL of several heartbeats. Liveness is
 *   therefore expiry: nothing has to delete anything when a process dies,
 *   because a process that stopped writing stops existing. This is what makes a
 *   `kill -9`'d instance's rooms leave the fleet view on their own.
 * - An **index** is a sorted set whose members are the identifiers of live
 *   snapshots, scored by the publisher's wall clock in epoch milliseconds. It
 *   exists so a reader can enumerate the fleet with one `ZRANGEBYSCORE` plus
 *   one `MGET` instead of a `SCAN`, which is O(keyspace) and unusable on a hot
 *   path. Sorted sets have no TTL per member, so a reader must range from
 *   `now - TTL` rather than trusting the whole set, and publishers prune with
 *   `ZREMRANGEBYSCORE`.
 *
 * Scores are wall-clock epoch milliseconds from the writing host, which means
 * they carry that host's clock skew. That is fine for the one thing they are
 * used for - deciding whether a snapshot is within a multi-second TTL - and is
 * not fine for anything finer. Latency figures are never computed from these;
 * they are measured inside a single process and travel inside the payload.
 *
 * Identifiers interpolated below (`sessionUid`, `nodeInstanceId`,
 * `transcriptionHost`) must not contain `:`, or they would forge a key in
 * another part of the namespace. Session uids are uuids and hosts are
 * hostnames, so this holds today; the services that supply the configurable
 * ones validate them at config load rather than here, so a bad value fails at
 * boot instead of once per heartbeat.
 */
export const TELEMETRY_NAMESPACE = 'scribe:v1';

/**
 * Index of Node Server instances that have published recently.
 *
 * Member is `nodeInstanceId`, score is the publish time. Read this rather than
 * deriving the instance list from session records: an instance with no
 * sessions is idle, not absent, and only its own snapshot can say so.
 */
export const NODE_INDEX_KEY = `${TELEMETRY_NAMESPACE}:nodes:index`;

/**
 * Process-wide telemetry for one Node Server instance.
 *
 * Value is a `NodeSnapshot`.
 */
export function nodeSnapshotKey(nodeInstanceId: string): string {
  return `${TELEMETRY_NAMESPACE}:node:${nodeInstanceId}`;
}

/**
 * Index of sessions live anywhere in the fleet.
 *
 * Member is `sessionUid`, score is the publish time of its snapshot.
 */
export const SESSION_INDEX_KEY = `${TELEMETRY_NAMESPACE}:sessions:index`;

/**
 * One live session's telemetry, written by the Node Server instance that owns
 * it.
 *
 * Value is a `SessionSnapshot`. Sticky routing guarantees a single owner per
 * session, so there is exactly one writer per key; were that to change,
 * last-writer-wins on the whole value is still coherent, because both owners
 * would be describing the same session.
 */
export function sessionSnapshotKey(sessionUid: string): string {
  return `${TELEMETRY_NAMESPACE}:session:${sessionUid}`;
}

/**
 * Which Node Server instance owns a session's upstream.
 *
 * Value is a bare `nodeInstanceId`, not JSON: it is read to answer "who do I
 * ask about this room", and keeping it a plain string means a reader can use
 * it without parsing. It is a separate key from the session snapshot so that
 * lookup does not have to fetch and parse the whole record.
 */
export function sessionRouteKey(sessionUid: string): string {
  return `${TELEMETRY_NAMESPACE}:route:${sessionUid}`;
}

/**
 * Index of Transcription Service hosts that have published recently.
 *
 * Member is `transcriptionHost`, score is the publish time.
 */
export const TRANSCRIPTION_HOST_INDEX_KEY = `${TELEMETRY_NAMESPACE}:transcription-hosts:index`;

/**
 * One Transcription Service host's provider health, workers and counters.
 *
 * Value is a `TranscriptionHostSnapshot` - the entire `GET /providers/health`
 * body, not one key per provider as the first draft of this schema had it. A
 * host publishes all of its providers from a single read of its registry, so
 * splitting them buys no independent freshness while costing a second index
 * and a composite member that would have to be parsed back apart. Holding them
 * together also makes each read internally consistent: the worker list and the
 * providers that ran on those workers are always from the same instant.
 */
export function transcriptionHostSnapshotKey(
  transcriptionHost: string,
): string {
  return `${TELEMETRY_NAMESPACE}:ts:${transcriptionHost}`;
}
