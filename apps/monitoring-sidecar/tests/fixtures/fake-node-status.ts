import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A session entry as `GET /api/node-server/v1/status` reports it.
 * Restated here (rather than imported) so a test can construct a partial one.
 */
export interface FakeSession {
  sessionUid: string;
  sourceCount: number;
  subscriberCount: number;
  pendingChunkCount: number;
  upstreamState:
    | 'IDLE'
    | 'CONNECTING'
    | 'HANDSHAKING'
    | 'OPEN'
    | 'WAITING_RETRY'
    | 'CLOSED';
  upstreamRetryAttempt: number;
}

export interface FakeStatusBody {
  processUid: string;
  processStartedAt: string;
  generatedAt: string;
  summary: Record<string, number>;
  upstreamStateTransitions: { from: string; to: string; count: number }[];
  wsCloses: {
    code: number;
    reason: string;
    role: string;
    initiator: string;
    count: number;
  }[];
  authFailures: { reason: string; count: number }[];
  sessions: FakeSession[];
  sessionsTruncated: boolean;
}

const ZERO_SUMMARY = {
  activeSessionCount: 0,
  decodeDropsTotal: 0,
  pendingChunkEvictionsTotal: 0,
  upstreamChurnTotal: 0,
  authSuccessTotal: 0,
  authTimeoutsTotal: 0,
  orchestratorFailuresTotal: 0,
  latencySamplesTotal: 0,
  latencyE2eUnavailableTotal: 0,
  latencyE2eNegativeTotal: 0,
  latencyUnmatchedChunkTotal: 0,
};

export const FAKE_PROCESS_UID = '11111111-1111-4111-8111-111111111111';

/**
 * Builds a valid status body with everything at zero, overridden shallowly.
 * `summary` is merged rather than replaced so a test can set one counter
 * without restating the other ten.
 */
export function statusBody(
  overrides: Partial<Omit<FakeStatusBody, 'summary'>> & {
    summary?: Partial<typeof ZERO_SUMMARY>;
  } = {},
): FakeStatusBody {
  const { summary, ...rest } = overrides;
  return {
    processUid: FAKE_PROCESS_UID,
    processStartedAt: '2026-07-20T00:00:00.000Z',
    generatedAt: '2026-07-20T00:00:10.000Z',
    upstreamStateTransitions: [],
    wsCloses: [],
    authFailures: [],
    sessions: [],
    sessionsTruncated: false,
    ...rest,
    summary: { ...ZERO_SUMMARY, ...summary },
  };
}

export interface FakeNodeStatus {
  /** Base URL of the fake, e.g. `http://127.0.0.1:34567`. */
  baseUrl: string;
  statusUrl: string;
  /** Replaces the body served on the next poll. */
  setBody: (body: FakeStatusBody) => void;
  /** Serves this status code with an error body instead of the status payload. */
  setFailure: (status: number | null) => void;
  /** Serves a body that does not match the status schema. */
  setMalformed: (malformed: boolean) => void;
  /** Authorization headers seen, in order. */
  authHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/**
 * A stand-in for node-server's status endpoint.
 *
 * Real HTTP over loopback rather than a stubbed `fetch`: the poller's job is to
 * talk to a service across a network boundary, and stubbing the transport would
 * verify only that the test double agrees with the code under test. Faults are
 * injected by changing what this server returns, which is how they present in
 * production.
 */
export async function startFakeNodeStatus(
  apiKey: string,
): Promise<FakeNodeStatus> {
  let body = statusBody();
  let failure: number | null = null;
  let malformed = false;
  const authHeaders: (string | undefined)[] = [];

  const server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization);

    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'INVALID_SERVICE_KEY',
          message: 'Invalid or missing service API key.',
        }),
      );
      return;
    }

    if (failure !== null) {
      res.writeHead(failure, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'boom' }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(malformed ? { unexpected: true } : body));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  return {
    baseUrl,
    statusUrl: `${baseUrl}/api/node-server/v1/status`,
    setBody: (next) => {
      body = next;
    },
    setFailure: (status) => {
      failure = status;
    },
    setMalformed: (next) => {
      malformed = next;
    },
    authHeaders,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
