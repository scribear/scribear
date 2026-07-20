import { Type } from 'typebox';

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

const SESSION_SCHEMA = Type.Object(
  {
    sessionUid: Type.String({ format: 'uuid' }),
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
  },
  { $id: 'NodeServerStatusSession' },
);

const STATUS_SCHEMA = {
  description:
    'Operational telemetry for this Node Server process: connection, session and upstream counters that are otherwise only inferable from log text. Counters are monotonic since process start and are never reset - consumers difference successive reads to obtain rates, and must compare `processUid` first, because a restart returns every counter to zero and would otherwise read as a large negative rate. Intended for internal observability consumers (Monitoring Sidecar, Admin Server) on the cluster-internal network; it must not be exposed through the public reverse proxy.',
  tags: [STATUS_TAG],
  security: SERVICE_API_KEY_SECURITY,
  // Optional at the schema layer on purpose: request validation runs *before*
  // the preHandler that checks the key, so a required header would answer a
  // missing credential with 400 VALIDATION_ERROR. Leaving presence to the hook
  // means every credential problem - absent, wrong - answers 401, which is both
  // the correct HTTP semantic and a single thing for a consumer to alert on.
  // A present-but-malformed header (not `Bearer <key>`) still fails validation
  // with 400.
  headers: Type.Object({
    authorization: Type.Optional(SERVICE_API_KEY_AUTH_HEADER_SCHEMA),
  }),
  response: {
    200: Type.Object(
      {
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
            description:
              'Malformed SAFP frames dropped rather than forwarded (U2).',
          }),
          pendingChunkEvictionsTotal: Type.Integer({
            description:
              'Uncorrelated audio frames evicted at the per-session cap (N3).',
          }),
          upstreamChurnTotal: Type.Integer({
            description:
              'Transitions into WAITING_RETRY across all sessions (N1).',
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
            initiator: Type.Union([
              Type.Literal('server'),
              Type.Literal('peer'),
            ]),
            count: Type.Integer(),
          }),
          { description: LABELLED_COUNT_DESCRIPTION },
        ),
        authFailures: Type.Array(
          Type.Object({
            reason: Type.String(),
            count: Type.Integer(),
          }),
          { description: LABELLED_COUNT_DESCRIPTION },
        ),
        sessions: Type.Array(SESSION_SCHEMA, {
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
