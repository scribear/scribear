import { Type } from 'typebox';
import type { Static } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { NODE_SERVER_BASE_PATH } from '#src/base-path.js';
import {
  INVALID_SERVICE_KEY_REPLY_SCHEMA,
  SERVICE_API_KEY_AUTH_HEADER_SCHEMA,
  SERVICE_API_KEY_SECURITY,
} from '#src/shared/security/index.js';
import { STATUS_TAG } from '#src/tags.js';

/**
 * Maximum number of entries in `sessions`. Session count is bounded by real
 * capacity, which is small today, but the cap keeps the response from growing
 * without limit if that ever stops being true. `sessionsTruncated` reports
 * whether it bit: a silent cap would read as "that is all of them".
 */
export const STATUS_MAX_SESSIONS = 200;

/** Upstream (Node Server -> Transcription Service) connection states. */
const UPSTREAM_STATE_SCHEMA = Type.Union(
  [
    Type.Literal('IDLE'),
    Type.Literal('CONNECTING'),
    Type.Literal('HANDSHAKING'),
    Type.Literal('OPEN'),
    Type.Literal('WAITING_RETRY'),
    Type.Literal('CLOSED'),
  ],
  {
    description:
      'Upstream WebSocket state. Repeated entry into WAITING_RETRY is the N1 (upstream flap) signature.',
  },
);

const CONNECTION_ROLE_SCHEMA = Type.Union([
  Type.Literal('source'),
  Type.Literal('client'),
]);

const LABELLED_COUNT_DESCRIPTION =
  'Monotonic since process start. Absent label combinations have never occurred; they are omitted rather than reported as zero.';

/**
 * One latency distribution, over the samples the reporting process still
 * retains (B1.4).
 *
 * `count` and `sum` are lifetime totals and behave like the monotonic
 * `summary` counters in {@link STATUS_PROCESS_SCHEMA} - difference them for a
 * rate. Everything else describes only the retained ring, so it is a gauge of
 * recent behaviour: once the ring wraps, `mean` and `sum / count` legitimately
 * disagree.
 *
 * These are `Type.Number()`, not `Type.Integer()` like every other figure in
 * this response: `pipelineMs` comes off `performance.now()` and is fractional,
 * and a mean or percentile of integers need not be one.
 *
 * The field set matches the histogram series transcription-service reports from
 * its own metrics endpoint, so a consumer can render either service's latency
 * with one component.
 */
export const LATENCY_SERIES_SCHEMA = Type.Object({
  measure: Type.Union([Type.Literal('pipeline'), Type.Literal('e2e')], {
    description:
      '`pipeline` is audio ingress -> transcript received, measured entirely on this process’s monotonic clock. `e2e` additionally includes capture and uplink, using the source’s clock-corrected send time, and is therefore only as trustworthy as time-sync (S5).',
  }),
  kind: Type.Union([Type.Literal('final'), Type.Literal('inProgress')], {
    description:
      'Which transcript the samples describe. Reported separately because interim and final transcripts are different populations - a final is only emitted once the provider decides an utterance ended - and pooling them yields percentiles that describe neither.',
  }),
  count: Type.Number({
    description: 'Samples observed since process start.',
  }),
  sum: Type.Number({
    description: 'Sum of every sample since process start, in milliseconds.',
  }),
  sampleCount: Type.Number({
    description:
      'Samples currently retained. The percentiles below describe exactly these.',
  }),
  min: Type.Number(),
  max: Type.Number(),
  mean: Type.Number(),
  p50: Type.Number(),
  p95: Type.Number(),
  p99: Type.Number(),
});

const LATENCY_ARRAY_DESCRIPTION =
  'Latency distributions, one entry per (measure, kind). A series that has never been observed is omitted rather than reported as zeroes - notably, `e2e` series are absent entirely when no source supplies a send timestamp, which is not the same as an end-to-end latency of zero. Milliseconds throughout.';

/**
 * One live session's gauges.
 *
 * Exported because this process is not the only place these records surface:
 * the Redis telemetry backplane publishes the same record per session so the
 * fleet view can read every instance's rooms at once (B1.7). Sharing the
 * schema rather than restating it is what keeps a field added here from
 * silently meaning something else there - the same argument transcription
 * service's `serialize_worker` makes for its two endpoints.
 */
export const STATUS_SESSION_SCHEMA = Type.Object(
  {
    sessionUid: Type.String({ format: 'uuid' }),
    // Optional so a session record produced before this field existed still
    // validates, and nullable because a session's room is not always known.
    roomUid: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    providerKey: Type.String({
      description:
        'Transcription provider this session’s upstream was opened against, as configured when the session was created. Operator-chosen free text on the Transcription Service side, so it is reported verbatim and never parsed; it is what joins a room to the provider health reported for it (B1.7 §11).',
    }),
    sourceCount: Type.Integer({
      description: 'Source-role connections feeding this session.',
    }),
    subscriberCount: Type.Integer({
      description:
        'Connections subscribed to this session, both roles. Fan-out cost is dominated by receive-only clients (N4).',
    }),
    pendingChunkCount: Type.Integer({
      description:
        'Audio frames sent upstream and still awaiting a matching transcript. Sitting at the cap means latency correlation is degraded (N3).',
    }),
    upstreamState: UPSTREAM_STATE_SCHEMA,
    upstreamRetryAttempt: Type.Integer({
      description:
        'Consecutive reconnect attempts for this session’s upstream. Non-zero while flapping; back to 0 once a connection is established.',
    }),
    audioFramesReceived: Type.Optional(
      Type.Integer({
        description:
          'Binary frames received from the source since the session opened, counted before decode so a malformed frame still registers as "the source is sending something" (the malformed subset is `decodeDropsTotal`). Monotonic per session, resets on session end. Lets the fleet dashboard distinguish "source sent nothing" (0) from "source is sending but the ASR is silent" (>0) — the two cases that "no audio reaching ASR" alone cannot tell apart. Optional for backward-compat with older publishers that do not emit it.',
      }),
    ),
    sourceMicrophoneActive: Type.Optional(
      Type.Union([Type.Boolean(), Type.Null()], {
        description:
          'Whether at least one connected source has its microphone active (unmuted). Null when no source has reported state yet. Absent when no source has reported and the publisher predates the field. Lets the fleet dashboard distinguish "mic is off" from "something broke" when no audio frames arrive.',
      }),
    ),
    latency: Type.Array(LATENCY_SERIES_SCHEMA, {
      description: `Per-session latency (B1.4). ${LATENCY_ARRAY_DESCRIPTION} Retained per session and discarded when the session’s last connection closes, so unlike the process-wide series these describe live rooms only.`,
    }),
  },
  { $id: 'NodeServerStatusSession' },
);

/** One live session's gauges. @see {@link STATUS_SESSION_SCHEMA} */
export type StatusSession = Static<typeof STATUS_SESSION_SCHEMA>;

/**
 * Everything this process reports about itself, excluding the per-session
 * list.
 *
 * Split out and exported for the same reason as {@link STATUS_SESSION_SCHEMA}:
 * the Redis telemetry backplane publishes this record per Node Server instance
 * (B1.7), which is what distinguishes an instance that is up and idle from one
 * that has died - a fleet view assembled only from session records cannot tell
 * those apart, because both contribute no sessions.
 */
export const STATUS_PROCESS_SCHEMA = Type.Object({
  processUid: Type.String({
    format: 'uuid',
    description:
      'Identifies this process instance; regenerated on every boot. A change means the counters below restarted from zero.',
  }),
  processStartedAt: Type.String({ format: 'date-time' }),
  generatedAt: Type.String({
    format: 'date-time',
    description:
      'When this response was assembled. Lets a consumer bound the age of the numbers independently of its own clock.',
  }),
  summary: Type.Object({
    activeSessionCount: Type.Integer({
      description: 'Sessions currently holding an upstream connection.',
    }),
    decodeDropsTotal: Type.Integer({
      description: 'Malformed SAFP frames dropped rather than forwarded (U2).',
    }),
    // Optional for the same reason as `audioFramesReceived` on
    // STATUS_SESSION_SCHEMA (named rather than pointed at: "above"/"below" rots
    // the moment a field moves), and it matters more here: this record is
    // republished to Redis and read back by admin-server through a strict
    // `Value.Check`, so a required field that an older publisher omits does not
    // degrade to a missing counter - it fails the whole snapshot and the node
    // disappears from the fleet view for the length of a rolling deploy.
    binaryBeforeAuthDropsTotal: Type.Optional(
      Type.Integer({
        description:
          'Binary frames a source sent before its AUTH handshake completed. Dropped rather than closed: a source that starts streaming before AUTH_OK would otherwise be closed 1008 `binary-before-auth` and reconnect-loop, because each reconnect re-sends AUTH and the next first chunk again beats AUTH_OK. Optional for backward-compat with publishers that predate it.',
      }),
    ),
    pendingChunkEvictionsTotal: Type.Integer({
      description:
        'Uncorrelated audio frames evicted at the per-session cap (N3).',
    }),
    upstreamChurnTotal: Type.Integer({
      description: 'Transitions into WAITING_RETRY across all sessions (N1).',
    }),
    authSuccessTotal: Type.Integer({
      description:
        'Successful WebSocket auth handshakes. The denominator for the failure ratio: a signing-key mismatch shows up as failures approaching 100%, which a failure count alone cannot distinguish from a few bad clients (S2).',
    }),
    authTimeoutsTotal: Type.Integer({
      description:
        'Connections that never sent `auth` inside the watchdog window (U3).',
    }),
    orchestratorFailuresTotal: Type.Integer({
      description:
        'Source registrations that threw, closing the socket with 1011.',
    }),
    latencySamplesTotal: Type.Integer({
      description:
        'Latency samples published. The denominator for the two figures below.',
    }),
    latencyE2eUnavailableTotal: Type.Integer({
      description:
        'Samples whose source supplied no send timestamp, so no end-to-end figure was computable.',
    }),
    latencyE2eNegativeTotal: Type.Integer({
      description:
        'Samples whose end-to-end time computed negative - the source clock is still ahead of ours despite sync. Meaningful as a ratio of `latencySamplesTotal`, not as a count (S5).',
    }),
    latencyUnmatchedChunkTotal: Type.Integer({
      description:
        'Transcripts referencing a chunk already evicted or pruned (N3).',
    }),
  }),
  upstreamStateTransitions: Type.Array(
    Type.Object({
      from: UPSTREAM_STATE_SCHEMA,
      to: UPSTREAM_STATE_SCHEMA,
      count: Type.Integer(),
    }),
    { description: LABELLED_COUNT_DESCRIPTION },
  ),
  wsCloses: Type.Array(
    Type.Object({
      code: Type.Integer(),
      reason: Type.String({
        description:
          'Close reason, normalised to a known-reason allowlist. Peer-initiated closes carry arbitrary remote text, which collapses to `other`.',
      }),
      role: CONNECTION_ROLE_SCHEMA,
      initiator: Type.Union([Type.Literal('server'), Type.Literal('peer')]),
      count: Type.Integer(),
    }),
    { description: LABELLED_COUNT_DESCRIPTION },
  ),
  latency: Type.Array(LATENCY_SERIES_SCHEMA, {
    description: `Process-wide latency across every session (B1.4). ${LATENCY_ARRAY_DESCRIPTION}`,
  }),
  authFailures: Type.Array(
    Type.Object({
      reason: Type.String(),
      count: Type.Integer(),
    }),
    { description: LABELLED_COUNT_DESCRIPTION },
  ),
});

/** This process's own telemetry. @see {@link STATUS_PROCESS_SCHEMA} */
export type StatusProcess = Static<typeof STATUS_PROCESS_SCHEMA>;

const STATUS_SCHEMA = {
  description:
    'Operational telemetry for this Node Server process: connection, session and upstream counters that are otherwise only inferable from log text. Counters are monotonic since process start and are never reset - consumers difference successive reads to obtain rates, and must compare `processUid` first, because a restart returns every counter to zero and would otherwise read as a large negative rate. Intended for internal observability consumers (Monitoring Sidecar, Admin Server) on the cluster-internal network; it must not be exposed through the public reverse proxy.',
  tags: [STATUS_TAG],
  security: SERVICE_API_KEY_SECURITY,
  // Optional at the schema layer on purpose: request validation runs *before*
  // the preHandler that checks the key, so a required header would answer a
  // missing credential with 400 VALIDATION_ERROR. Leaving presence to the hook
  // means every credential problem - absent, malformed, wrong - answers 401,
  // which is both the correct HTTP semantic and a single thing for a consumer to
  // alert on. The header schema carries no `pattern` for the same reason, so a
  // present-but-malformed header reaches the hook too; see
  // SERVICE_API_KEY_AUTH_HEADER_SCHEMA.
  headers: Type.Object({
    authorization: Type.Optional(SERVICE_API_KEY_AUTH_HEADER_SCHEMA),
  }),
  response: {
    200: Type.Object(
      {
        ...STATUS_PROCESS_SCHEMA.properties,
        sessions: Type.Array(STATUS_SESSION_SCHEMA, {
          maxItems: STATUS_MAX_SESSIONS,
          description:
            'Live per-session gauges. Unlike the counters above these are point-in-time and vanish when the session ends.',
        }),
        sessionsTruncated: Type.Boolean({
          description: `True when more than ${String(STATUS_MAX_SESSIONS)} sessions were active and \`sessions\` lists only the first ${String(STATUS_MAX_SESSIONS)}. \`summary.activeSessionCount\` is always the real total.`,
        }),
      },
      { description: 'Telemetry snapshot for this process.' },
    ),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_SERVICE_KEY_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

const STATUS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${NODE_SERVER_BASE_PATH}/status`,
};

export { STATUS_SCHEMA, STATUS_ROUTE };
