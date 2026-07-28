import { Type } from 'typebox';
import type { Static } from 'typebox';

import { SNAPSHOT_ENVELOPE_PROPERTIES } from './snapshot-envelope.schema.js';
import { type SnapshotParseResult, parseSnapshot } from './snapshot-parse.js';

/**
 * One job a worker is actively running, correlated to the opaque session/room
 * identifiers node-server sent when it opened the stream.
 *
 * Either uid is null when the caller supplied none (an older node-server
 * peer, or a session opened before the CONFIG message carried them) - mirrors
 * `ActiveJob` in transcription service, not omitted, for the same
 * fixed-shape reasoning as the rest of this file.
 */
const ACTIVE_JOB_SCHEMA = Type.Object({
  jobId: Type.Integer(),
  sessionUid: Type.Union([Type.String(), Type.Null()]),
  roomUid: Type.Union([Type.String(), Type.Null()]),
});

/** One job a worker is actively running. @see {@link ACTIVE_JOB_SCHEMA} */
export type ActiveJob = Static<typeof ACTIVE_JOB_SCHEMA>;

/**
 * One worker process on a Transcription Service host.
 *
 * This restates, in TypeScript, the shape `serialize_worker` produces in
 * transcription service. The duplication is unavoidable - the Python service
 * shares no schema package with the Node apps - and is the reason this file
 * exists at all: with the shape written down once on this side, a field that
 * changes there fails validation at the reader instead of rendering as
 * `undefined` somewhere in the fleet view. The monitoring sidecar restates the
 * same shape for the same reason.
 */
export const TRANSCRIPTION_WORKER_SCHEMA = Type.Object({
  workerId: Type.Integer(),
  utilization: Type.Number({
    description:
      'Rolling fraction of wall time this worker spent processing, 0..1. A freshly started worker reports 1.0 with no jobs, so utilisation alone does not mean saturated.',
  }),
  liveJobCount: Type.Integer(),
  totalJobsRegistered: Type.Integer({
    description: 'Monotonic since process start.',
  }),
  contextIds: Type.Array(Type.Integer(), {
    description:
      'Ids of the model contexts loaded on this worker. Each context is a full copy of its model, which is why worker count is bounded by memory rather than by cores. Integers, not context tags: the publisher holds `context_ids: set[int]` and emits `sorted(...)` of it (`worker_view.py`), so these are opaque numeric ids and carry no name. The monitoring sidecar, which restates the same endpoint by hand, has always had this right (`transcription-metrics.schema.ts`).',
  }),
  alive: Type.Boolean({
    description:
      'False once the OS process is gone. A worker that dies after startup is otherwise invisible - jobs already registered to it neither return nor raise (B1.3).',
  }),
  activeJobs: Type.Array(ACTIVE_JOB_SCHEMA, {
    description:
      'Jobs currently registered to this worker, correlated to the session/room that opened each - what lets an operator trace a saturated worker back to who is saturating it, beyond the aggregate liveJobCount.',
  }),
  estimatedCapacitySessions: Type.Union([Type.Integer(), Type.Null()], {
    description:
      'N* (PLAN-AdmissionControl.md §3/§5): the current auto-tuned session ceiling for this worker, or the operator-pinned `max_sessions` when set. Always present, never absent, because the publisher always has an estimator to ask - but null while the worker is still warming up (too few clean measurement windows yet) or has never had a clean window. Null means "not measured yet", never zero or unlimited - do not render it as either.',
  }),
});

/** One worker process. @see {@link TRANSCRIPTION_WORKER_SCHEMA} */
export type TranscriptionWorker = Static<typeof TRANSCRIPTION_WORKER_SCHEMA>;

/**
 * Health of one configured transcription provider on one host.
 *
 * Fields that do not apply to a provider's kind are null rather than absent,
 * matching the endpoint this comes from: a fixed shape is what lets a reader
 * require every field and so catch drift at parse time, where an optional
 * field that stopped being sent would read as a legitimate absence.
 */
export const PROVIDER_HEALTH_SCHEMA = Type.Object({
  providerUid: Type.String({
    description:
      'Implementation identity from provider config - which provider class serves this key.',
  }),
  kind: Type.Union([
    Type.Literal('local'),
    Type.Literal('remote'),
    Type.Literal('debug'),
    Type.Literal('unknown'),
  ]),
  status: Type.Union([
    Type.Literal('ok'),
    Type.Literal('degraded'),
    Type.Literal('down'),
  ]),
  activeSessions: Type.Integer(),
  model: Type.Union([Type.String(), Type.Null()]),
  modelLoaded: Type.Union([Type.Boolean(), Type.Null()], {
    description:
      'Local providers only. False means no live worker owns every context this provider routes to, so the provider is dead even though readiness is green (P2).',
  }),
  owningWorkers: Type.Array(TRANSCRIPTION_WORKER_SCHEMA, {
    description:
      'Local providers only; empty for others. The workers that can serve this provider, so a saturated provider can be traced to the worker saturating it.',
  }),
  endpoint: Type.Union([Type.String(), Type.Null()], {
    description: 'Remote providers only.',
  }),
  reachable: Type.Union([Type.Boolean(), Type.Null()], {
    description:
      'Remote providers only. Answers a cached probe, not a request made for this read, so it lags reality by at most the probe TTL and never adds load to the upstream per dashboard poll.',
  }),
  probeLatencyMs: Type.Union([Type.Number(), Type.Null()], {
    description: 'Remote providers only; null when the probe did not complete.',
  }),
  detail: Type.Union([Type.String(), Type.Null()], {
    description: 'Last error or note. Free text, for operators, not parsing.',
  }),
});

/** Health of one provider on one host. @see {@link PROVIDER_HEALTH_SCHEMA} */
export type ProviderHealth = Static<typeof PROVIDER_HEALTH_SCHEMA>;

/**
 * One Transcription Service host as published to the backplane: its entire
 * `GET /providers/health` body plus the snapshot envelope.
 *
 * Provider keys are operator-chosen configuration, so this is a record keyed by
 * arbitrary strings rather than a fixed set of fields, and the keys are carried
 * verbatim - never re-cased - exactly as the endpoint reports them.
 *
 * The same provider key may appear on several hosts. A reader merging them must
 * treat the provider as down only when it is down on every host serving it; a
 * single host's `down` means that host cannot serve it, which is a capacity
 * loss, not an outage.
 */
export const TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA = Type.Object({
  ...SNAPSHOT_ENVELOPE_PROPERTIES,
  transcriptionHost: Type.String({
    description:
      'Hostname of the publishing Transcription Service. Stable across restarts; `processUid` distinguishes runs of it.',
  }),
  processUid: Type.String({
    format: 'uuid',
    description:
      'Process instance, regenerated on every boot. The same uid this host reports from `/metrics/status`, so counters from the two can be correlated - and the guard a reader must check before differencing `invalidProviderKeyRejects`, which returns to zero on restart.',
  }),
  processStartedAt: Type.String({ format: 'date-time' }),
  numWorkers: Type.Integer({
    description:
      'Worker processes configured on this host. Each is a full model copy running its jobs strictly one at a time, so this is the ceiling on concurrent transcription here (§13.1).',
  }),
  invalidProviderKeyRejects: Type.Integer({
    description:
      'Sessions refused because the requested provider key is not configured - monotonic since process start. Catches the free-text `transcriptionProviderId` typo, which otherwise fails only at the client (P6).',
  }),
  workers: Type.Array(TRANSCRIPTION_WORKER_SCHEMA),
  providers: Type.Record(Type.String(), PROVIDER_HEALTH_SCHEMA, {
    description: 'Keyed by configured provider key, verbatim.',
  }),
});

/**
 * One Transcription Service host's published record.
 * @see {@link TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA}
 */
export type TranscriptionHostSnapshot = Static<
  typeof TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA
>;

/**
 * Validating parser for a Transcription Service host key's value.
 *
 * This is the one of the four snapshot schemas with no compiler behind it.
 * `redis_telemetry_publisher.py` hand-builds the record as a Python dict and
 * `json.dumps` it, so this schema is a mirror across a language boundary - the
 * same arrangement that produced two real cross-surface divergences in the
 * audio meter before a shared expectation table caught them, and that hid a
 * `contextIds` element-type bug here from the day this schema was written.
 *
 * The reader **drops** a value this rejects, and logs a throttled warn
 * (admin-server's `FleetTelemetryService._readIndexed`). It validated in a
 * log-only mode for a release instead, deliberately: a hard drop on an
 * unverified mirror blanks both the hosts section and the providers section of
 * the fleet view, because `mergeProviders` derives from `transcriptionHosts` -
 * a dashboard-wide outage caused by the check meant to protect the dashboard.
 *
 * What made the promotion safe was not a quiet log - that proves only that
 * nothing is being dropped right now - but pinning the Python side against this
 * schema, in two legs, because neither alone reaches the whole shape:
 * `tools/telemetry-snapshot-crosscheck/` (manifest emitted by
 * `RedisTelemetryPublisher.publish_once`, carrying the loaded-worker shapes a
 * debug-only host leaves empty) and node-server's
 * `publisher-schema-crosscheck.test.ts` (real publisher, real Redis, real
 * transport, but empty nested arrays that satisfy any element type). Apply the
 * same rule to the next mirror: the oracle has to be the other implementation,
 * never a fixture written from this schema.
 */
export function parseTranscriptionHostSnapshot(
  raw: string,
): SnapshotParseResult<TranscriptionHostSnapshot> {
  return parseSnapshot(TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA, raw);
}
