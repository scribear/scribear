import type {
  NodeSnapshot,
  ProviderHealth,
  TranscriptionHostSnapshot,
} from '#src/lib/admin-api';

/**
 * A healthy node-server instance: handshakes accepted, nothing rejected, no
 * socket has closed. Overrides are shallow, so a case changing one `summary`
 * counter spreads `buildNode().summary` itself.
 */
export function buildNode(overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    processUid: 'proc-1',
    processStartedAt: '2026-08-02T14:02:00.000Z',
    generatedAt: '2026-08-02T17:13:00.000Z',
    summary: {
      activeSessionCount: 1,
      decodeDropsTotal: 0,
      pendingChunkEvictionsTotal: 0,
      upstreamChurnTotal: 0,
      authSuccessTotal: 10,
      authTimeoutsTotal: 0,
      orchestratorFailuresTotal: 0,
      latencySamplesTotal: 0,
      latencyE2eUnavailableTotal: 0,
      latencyE2eNegativeTotal: 0,
      latencyUnmatchedChunkTotal: 0,
    },
    upstreamStateTransitions: [],
    wsCloses: [],
    latency: [],
    authFailures: [],
    updatedAt: 1_000,
    nodeInstanceId: 'node-a',
    ...overrides,
  };
}

/**
 * A Transcription Service host serving one provider key and refusing nothing.
 * `binaryBeforeAuthDropsTotal` and `endedSessionRegistrationsTotal` are
 * deliberately absent from {@link buildNode} for the same reason they are
 * optional on the wire: the default fixture is an older publisher, so a
 * consumer that treats "not reported" as zero fails here rather than in
 * production during a rolling deploy.
 */
export function buildHost(
  overrides: Partial<TranscriptionHostSnapshot> = {},
): TranscriptionHostSnapshot {
  const provider: ProviderHealth = {
    providerUid: 'p-1',
    kind: 'local',
    status: 'ok',
    activeSessions: 0,
    sessionsRefusedCapacityTotal: 0,
    model: 'base',
    modelLoaded: true,
    owningWorkers: [],
    endpoint: null,
    reachable: null,
    probeLatencyMs: null,
    detail: null,
  };
  return {
    updatedAt: 1_000,
    transcriptionHost: 'ts-1',
    processUid: 'ts-proc-1',
    processStartedAt: '2026-08-02T14:00:00.000Z',
    numWorkers: 2,
    invalidProviderKeyRejects: 0,
    workers: [],
    providers: { whisper: provider },
    ...overrides,
  };
}
