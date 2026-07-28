import type {
  AutoSessionWindow,
  Device,
  Room,
  Session,
  SessionSchedule,
} from '@scribear/session-manager-schema';

import { ApiError } from './api-error';

export type ScheduleFrequency = 'ONCE' | 'WEEKLY' | 'BIWEEKLY';
export type DayOfWeek = 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT';
export type SessionScope = 'SEND_AUDIO' | 'RECEIVE_TRANSCRIPTIONS';

export interface AuditRow {
  id: string;
  actorSubject: string;
  actorProvider: string;
  action: string;
  target: string | null;
  paramsSummary: unknown;
  result: string;
  statusCode: number | null;
  requestId: string | null;
  createdAt: string;
}

export interface TimeRangeQuery {
  roomUid: string;
  from?: string;
  to?: string;
}

export interface CreateScheduleBody {
  roomUid: string;
  name: string;
  activeStart: string;
  activeEnd: string | null;
  localStartTime: string;
  localEndTime: string;
  frequency: ScheduleFrequency;
  daysOfWeek: DayOfWeek[] | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: unknown;
}

export type UpdateScheduleBody = { scheduleUid: string } & Partial<
  Omit<CreateScheduleBody, 'roomUid'>
>;

export interface CreateAutoWindowBody {
  roomUid: string;
  localStartTime: string;
  localEndTime: string;
  daysOfWeek: DayOfWeek[];
  activeStart: string;
  activeEnd: string | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: unknown;
}

export type UpdateAutoWindowBody = { windowUid: string } & Partial<
  Omit<CreateAutoWindowBody, 'roomUid'>
>;

export interface CreateOnDemandSessionBody {
  roomUid: string;
  name: string;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: unknown;
}

export interface SessionsRangeQuery {
  roomUids?: string[];
  from: string; // ISO
  to: string; // ISO
}

const BASE = '/api/admin/v1';

/** `EventSource` can't go through `_request` (it sends no cookie header the
 *  way `fetch` does — it relies on `withCredentials` instead), so the fleet
 *  stream hook needs the raw URL. */
export const FLEET_STREAM_URL = `${BASE}/fleet/stream`;

/**
 * How often `useFleet()` re-reads `/fleet` on a timer, in addition to the
 * SSE (re)connect re-fetch. Audio levels move on a 2 s publish throttle with a
 * 10 s TTL; a 5 s poll means a reading is at most ~7 s old, and a genuinely
 * dead stream disappears within one poll of expiry. Node/session counters are
 * slow-moving enough that this also refreshes them usefully, which is a fix
 * but a behaviour change to a shipped panel.
 */
export const FLEET_POLL_INTERVAL_MS = 5_000;

/**
 * Expiry on session audio-stats keys — 5 × 2 s = 10 s. Restated from
 * `infra/scribear-redis/src/telemetry/telemetry-timing.ts` (same reasoning as
 * the fleet mirrors: that package pulls in ioredis). Used by the session detail
 * page to flag a stale audio reading.
 */
export const AUDIO_STATS_TTL_MS = 10_000;

export interface AuthConfig {
  local: boolean;
  sso: boolean;
}

export interface Identity {
  subject: string;
  displayName: string;
  provider: 'local' | 'sso';
  roles: string[];
}

export interface SessionInfo {
  identity: Identity;
  csrfToken: string;
}

/** One dependency in the BFF health rollup. */
export interface HealthComponent {
  /** Stable identifier, matching the compose service name where there is one. */
  name: string;
  /** 'ok' | 'degraded' | 'unreachable' | 'fail' | 'not-configured'; kept loose
   *  so a new status added server-side renders rather than breaking the
   *  build. */
  status: string;
  latencyMs: number;
  /** One-line cause when the component is not ok. */
  detail?: string;
}

/**
 * Status of the demo caption room. `enabled` reflects the
 * server flag; `active` means the seeded session is currently joinable; a
 * non-null `joinCode` is a currently-valid code (it rotates ~every 5 min, so
 * the dashboard re-polls to keep it fresh).
 */
export interface DemoRoomStatus {
  enabled: boolean;
  sessionUid: string;
  active: boolean;
  roomName: string | null;
  joinCode: string | null;
}

/**
 * Join-code status for an arbitrary live session, mirrored from
 * `AdminJoinCodeStatus` (session-manager-schema). `ok` is the only status with
 * a non-null `joinCode`/`validEnd` — `not-active` and `no-join-scopes` are
 * legitimate, expected states, not errors.
 */
export interface SessionJoinCodeStatus {
  status: 'ok' | 'not-active' | 'no-join-scopes';
  joinCode: string | null;
  validEnd: string | null;
}

export interface HealthReport {
  bff: string;
  /** Every checked dependency. A list rather than named fields so the
   *  dashboard renders new components (B1.7 providers, and so on) without a
   *  matching SPA change. */
  components: HealthComponent[];
  checkedAt: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- Config check ----
// Mirrors `ConfigCheckReport` in
// apps/admin-server/src/server/features/config-check/config-check.service.ts.

/** Kept loose so a severity added server-side renders rather than breaking the
 *  build — same reasoning as `HealthComponent.status`. */
export type CheckSeverity = 'critical' | 'warning' | 'advisory' | 'ok';

export interface ConfigFinding {
  id: string;
  category: string;
  title: string;
  /** Severity in the environment that was checked. */
  severity: CheckSeverity;
  /** What the same finding would be in production. Equal to `severity` when
   *  the checked environment is production. */
  productionSeverity: CheckSeverity;
  /** Never contains a secret value — the server reports classifications. */
  detail: string;
  remediation?: string;
  /** Deep link to the relevant deployment wiki page, when the server set one. */
  docUrl?: string;
}

export interface ConfigCheckReport {
  environment: 'development' | 'staging' | 'production';
  environmentSource: 'explicit' | 'inferred';
  findings: ConfigFinding[];
  summary: Record<CheckSeverity, number>;
  /** Findings that are critical in production, whatever they are here. */
  blockingForProduction: number;
  checkedAt: string;
}

// ---- Deployment versions ----
// Mirrors `DeploymentVersionsReport` in
// apps/admin-server/src/server/features/deployment-versions/deployment-versions.service.ts.

/** Where the image a container is running came from. Kept loose for the same
 *  reason `HealthComponent.status` is. */
export type BuildOrigin = 'ci' | 'local' | 'unknown';

/** What one container reports about the artifact it was built from. Every
 *  string field is the literal 'unknown' when the build did not supply it —
 *  never blank, so a missing value cannot be read as a failed probe. */
export interface ContainerBuildInfo {
  service: string;
  version: string;
  commit: string;
  ref: string;
  builtAt: string;
  imageTags: string[];
  pullRequest: number | null;
  origin: BuildOrigin;
  /** Built from a working tree with uncommitted changes. */
  dirty: boolean;
}

/** 'ok' | 'unsupported' (image predates build reporting) | 'unreachable' |
 *  'not-reported' (no surface to ask, by design). */
export type VersionProbeStatus =
  | 'ok'
  | 'unsupported'
  | 'unreachable'
  | 'not-reported';

export interface ContainerVersion {
  service: string;
  status: VersionProbeStatus;
  /** Null for every status other than 'ok'. */
  build: ContainerBuildInfo | null;
  detail?: string;
}

/** 'match' | 'stale' (the compose file is older than the images) | 'ahead' (the
 *  images are older than the compose file) | 'unknown' (the file reported
 *  nothing, so it predates this check and is at least that old). */
export type ComposeFileStatus = 'match' | 'stale' | 'ahead' | 'unknown';

/** How `deployment/compose.yml` compares to the file admin-server's image was
 *  built for. The compose file is the one part of a deployment that is not an
 *  image, so pulling images cannot update it and no container can read it. */
export interface ComposeFileVersion {
  expected: number;
  /** Null when the compose file reported nothing, or nothing numeric. */
  reported: number | null;
  status: ComposeFileStatus;
}

export interface DeploymentVersionsReport {
  containers: ContainerVersion[];
  composeFile: ComposeFileVersion;
  /** The commit the deployment is taken to be — whichever the most containers
   *  report. Null when nothing reported one. */
  expectedCommit: string | null;
  /** Services whose commit is not `expectedCommit`. */
  mismatched: string[];
  locallyBuilt: string[];
  dirty: string[];
  /** Containers answered, and none knows its own commit. */
  unstamped: boolean;
  checkedAt: string;
}

// ---- Fleet telemetry (B1.7 §2.5) ----
// Mirrors `FleetSnapshot` in
// apps/admin-server/src/server/shared/services/fleet-telemetry.service.ts and
// the node-server / transcription-service snapshot schemas it composes, from
// @scribear/scribear-redis. Restated here rather than imported: that package
// depends on ioredis and has no browser-safe entry point, so importing it
// would pull a Node Redis client into this bundle. Kept in step by eye, the
// same way transcription-service's Python side restates the TypeScript
// contract (webserver/features/telemetry/telemetry_keys.py).

export interface LatencySeries {
  measure: 'pipeline' | 'e2e';
  kind: 'final' | 'inProgress';
  count: number;
  sum: number;
  sampleCount: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export type UpstreamState =
  | 'IDLE'
  | 'CONNECTING'
  | 'HANDSHAKING'
  | 'OPEN'
  | 'WAITING_RETRY'
  | 'CLOSED';

/** One live session, as published by the owning node-server instance. */
export interface SessionSnapshot {
  sessionUid: string;
  roomUid: string | null;
  providerKey: string;
  sourceCount: number;
  subscriberCount: number;
  pendingChunkCount: number;
  upstreamState: UpstreamState;
  upstreamRetryAttempt: number;
  /**
   * Binary frames received from the source since the session opened, counted
   * before decode (malformed frames included - they still prove the source is
   * sending). Optional: older node-server publishers that predate it omit it.
   * 0 = source sent nothing; >0 = source is sending (lets the fleet view
   * distinguish "kiosk sent nothing" from "upstream broke").
   */
  audioFramesReceived?: number;
  sourceMicrophoneActive?: boolean | null;
  latency: LatencySeries[]; /** Publish time, epoch ms, on the publishing host's clock. */
  updatedAt: number;
  nodeInstanceId: string;
  processUid: string;
}

/** One node-server instance's own counters, excluding its session list. */
export interface NodeSnapshot {
  processUid: string;
  processStartedAt: string;
  generatedAt: string;
  summary: {
    activeSessionCount: number;
    decodeDropsTotal: number;
    pendingChunkEvictionsTotal: number;
    upstreamChurnTotal: number;
    authSuccessTotal: number;
    authTimeoutsTotal: number;
    orchestratorFailuresTotal: number;
    latencySamplesTotal: number;
    latencyE2eUnavailableTotal: number;
    latencyE2eNegativeTotal: number;
    latencyUnmatchedChunkTotal: number;
  };
  upstreamStateTransitions: {
    from: UpstreamState;
    to: UpstreamState;
    count: number;
  }[];
  wsCloses: {
    code: number;
    reason: string;
    role: 'source' | 'client';
    initiator: 'server' | 'peer';
    count: number;
  }[];
  latency: LatencySeries[];
  authFailures: { reason: string; count: number }[];
  updatedAt: number;
  nodeInstanceId: string;
}

export interface TranscriptionWorker {
  workerId: number;
  utilization: number;
  liveJobCount: number;
  totalJobsRegistered: number;
  /**
   * Opaque numeric context ids, NOT context tags. The publisher holds
   * `context_ids: set[int]` and emits `sorted(...)` of it, so there is no name
   * here to render. This mirror said `string[]` until the reader started
   * validating and the real payload disagreed.
   */
  contextIds: number[];
  alive: boolean;
  activeJobs: {
    jobId: number;
    sessionUid: string | null;
    roomUid: string | null;
  }[];
  /**
   * N* (PLAN-AdmissionControl.md §3/§5): this worker's current auto-tuned
   * session ceiling, or the operator-pinned `max_sessions` when set. Always
   * present, sometimes `null` - `null` means "not measured yet" (warm-up, or
   * a worker that has never had a clean measurement window), never zero or
   * unlimited. Do not render it as either.
   */
  estimatedCapacitySessions: number | null;
}

/** Fields that don't apply to a provider's `kind` are `null`, never omitted. */
export interface ProviderHealth {
  providerUid: string;
  kind: 'local' | 'remote' | 'debug' | 'unknown';
  status: 'ok' | 'degraded' | 'down';
  activeSessions: number;
  sessionsRefusedCapacityTotal: number;
  model: string | null;
  modelLoaded: boolean | null;
  owningWorkers: TranscriptionWorker[];
  endpoint: string | null;
  reachable: boolean | null;
  probeLatencyMs: number | null;
  detail: string | null;
}

/** One Transcription Service host's entire `/providers/health` body, plus envelope. */
export interface TranscriptionHostSnapshot {
  updatedAt: number;
  transcriptionHost: string;
  processUid: string;
  processStartedAt: string;
  numWorkers: number;
  invalidProviderKeyRejects: number;
  workers: TranscriptionWorker[];
  /** Keyed by configured provider key, verbatim. */
  providers: Record<string, ProviderHealth>;
}

// ---- Audio-level telemetry (B2.1/B2.2, per-stage graph per §12) ----
// Mirrors `AudioLevelStats`, `VadStats`, `AudioStage` and
// `SessionAudioSnapshot` from
// infra/scribear-redis/src/telemetry/session-audio-snapshot.schema.ts, for the
// same reason the fleet mirrors above exist: @scribear/scribear-redis pulls in
// ioredis and has no browser-safe entry point. The nullability comments are
// copied verbatim from the schema — they encode real semantics (§6.2 and §12.2
// of PLAN-AUDIOVIZ) that a UI gets wrong by default.

/**
 * Audio-level readout for one session's most recent metering window
 * (B2.1: RMS/peak dBFS, clipping, silence, noise floor).
 */
export interface AudioLevelStats {
  /** RMS level of the current metering window, in dBFS. */
  rmsDbfs: number;
  /** Sample peak of the current metering window, in dBFS. */
  peakDbfs: number;
  /** Fraction (0..1) of samples in the window at or above 0.99 full scale in
   *  runs of at least 2 consecutive samples. The run requirement is what
   *  separates clipping from a waveform that merely touches full scale: a clean
   *  full-scale sine reaches 1.0 one isolated sample at a time and reads 0 here.
   *  Same rule and constants as the standalone meter page, so the two surfaces
   *  agree - see tools/audio-meter-crosscheck/. */
  clippingPct: number;
  /** True when the window's RMS is at or below the configured silence threshold. */
  silence: boolean;
  /** 10th-percentile RMS across 1s sub-windows of the metering window - an
   *  ambient noise-floor estimate, distinct from momentary silence. */
  noiseFloorDbfs: number;
}

/**
 * Per-batch voice-activity-detection statistics for one session (B2.2).
 *
 * Every field but `vadEnabled` is nullable, because "not meaningful" is a real,
 * distinct state here, not an edge case: `vadEnabled: false` means VAD never
 * ran, so the rest carries no signal at all; `vadEnabled: true` with the rest
 * present means VAD ran and measured something (including a real, meaningful
 * "found no speech" reading of `speechActiveRatio: 0`); `segmentCount: 0`
 * still nulls out `meanSegmentDurationSec` (no segment to average) and `snrDb`
 * (no signal side to compare against noise) even while VAD is on.
 */
export interface VadStats {
  /** Whether Silero VAD (config vad_detector) was enabled for this batch -
   *  always meaningful, even when every field below is null. */
  vadEnabled: boolean;
  /** Fraction (0..1) of the buffer VAD marked as speech. Null when vadEnabled is false. */
  speechActiveRatio: number | null;
  /** Number of speech segments VAD found in the buffer. Null when vadEnabled is false. */
  segmentCount: number | null;
  /** Mean speech-segment duration, in seconds. Null when vadEnabled is false, or
   *  when no segments were found (undefined, not zero). */
  meanSegmentDurationSec: number | null;
  /** speechActiveRatio / (1 - speechActiveRatio). Null when vadEnabled is false,
   *  or when speechActiveRatio is 1.0 (divide-by-zero guard at "all speech, no pause"). */
  speechToPauseRatio: number | null;
  /** Mean in-range RMS (dBFS) minus mean out-of-range RMS (dBFS), i.e. a VAD-gated
   *  signal-to-noise estimate. Null when vadEnabled is false, or when one side of
   *  the comparison has no samples (the buffer read as 0% or 100% speech). */
  snrDb: number | null;
}

/**
 * One measurement point in a session's audio pipeline (§12.2 of PLAN-AUDIOVIZ).
 *
 * Audio telemetry is a *directed graph* of these, not one reading: a single
 * reading cannot answer the question operators actually have — *where* did the
 * audio stop being good — and tying the reading to one provider's job made it
 * silently absent for the other providers (§12.1: `lumen_granite` and `debug`
 * showed a red audio chip on every healthy session).
 *
 * Every nullable field here means "this point does not measure that", never
 * "the measurement failed". A point that counts throughput only is a legitimate,
 * useful point — it still closes the funnel — so a reader must not fold
 * `levels: null` into the same bucket as "no snapshot at all".
 */
export interface AudioStage {
  /** Stable stage id, unique within one snapshot, e.g. `ingress`. An **open
   *  set**: a provider may report an id the shipped ones don't use and it is
   *  published and rendered like any other. What makes the graph work is
   *  `inputs`, not membership of a list. */
  stage: string;
  /** Operator-facing name, e.g. "ASR input (worker decode)". Carried on the
   *  wire rather than mapped from `stage` in the webapp, so a provider naming a
   *  new stage needs no dashboard change to render legibly. */
  label: string;
  /** Position in the pipeline: 1 at the source, `max(depth(inputs)) + 1`
   *  otherwise. **Derived at publish time** from `inputs` and shipped as a
   *  denormalised convenience so a reader never walks the graph — it is not the
   *  primitive. A cycle in a provider's declarations resolves to
   *  `current_max + 1` in declaration order rather than hanging the publisher.
   *  Never below 1: a 0 means depth resolution never ran, not that a point sits
   *  above the source. */
  depth: number;
  /** Stage ids immediately upstream of this one; `[]` means this is a source.
   *  An id naming a stage absent from this snapshot was dropped at publish time
   *  (that upstream point reported nothing this batch — an incomplete graph, not
   *  a fatal one), so a reader may still see an input it cannot resolve. */
  inputs: string[];
  /** Levels measured at this point, or null when this point **counts throughput
   *  only** and meters nothing (the `debug` provider's `asr_input`, and every
   *  VAD stage). Null is a statement about the measurement point, not about the
   *  audio: rendering it as a level of any kind would invent a reading. */
  levels: AudioLevelStats | null;
  /** VAD statistics for this point, or null when **this point runs no
   *  detector**. Distinct from `vadStats.vadEnabled === false`, which means a
   *  detector exists and did not run — see `VadStats`. */
  vad: VadStats | null;
  /** CUMULATIVE seconds of audio that have passed this point, monotonic — not a
   *  rate. A rate would have to agree with the reader's polling interval to be
   *  comparable between two points, and the two points do not share a clock;
   *  cumulative totals subtract cleanly across an edge, which is what makes
   *  "where did the audio get lost" a well-defined question. Null when this
   *  point does not count throughput. */
  audioSeconds: number | null;
}

/**
 * One live session's audio telemetry as published to the backplane: the graph
 * of measurement points, the snapshot envelope, and the session/room
 * identifiers it was computed for.
 *
 * `stages` replaces the flat `AudioLevelStats` spread and top-level `vadStats`
 * this snapshot carried before §12. There is deliberately **no compatibility
 * shim**: both sides ship from this repo and `AUDIO_STATS_TTL_MS` is 10 s, so a
 * rolling upgrade costs at most one poll of missing audio telemetry, whereas a
 * dual-shape reader would be permanent complexity bought for ten seconds.
 *
 * `stages` may be empty (nothing measured anything yet) and every stage's
 * `levels` may be null (a provider that reports throughput only). Both are real
 * states rather than error cases — see `deriveAudioStatus` in
 * `#src/features/dashboard/fleet-status` for how they classify, and why neither
 * may read as `good`.
 */
export interface SessionAudioSnapshot {
  /** Publish time in epoch milliseconds, on the publishing host's clock. */
  updatedAt: number;
  /** The measurement points that reported for this session, in no guaranteed
   *  order — consumers group by `depth` and must not assume array order. */
  stages: AudioStage[];
  sessionUid: string;
  roomUid: string | null;
  /** Identity of the publishing Transcription Service host. */
  transcriptionHost: string;
}

/** One provider merged across every Transcription Service host serving it.
 * `status` is `down` only when every host reporting this key is `down`, `ok`
 * only when every host is `ok`; `activeSessions` and
 * `sessionsRefusedCapacityTotal` are both summed.
 */
export interface MergedProvider {
  providerKey: string;
  status: 'ok' | 'degraded' | 'down';
  activeSessions: number;
  sessionsRefusedCapacityTotal: number;
  hosts: { transcriptionHost: string; health: ProviderHealth }[];
}

export interface FleetSnapshot {
  generatedAt: number;
  nodes: NodeSnapshot[];
  sessions: SessionSnapshot[];
  transcriptionHosts: TranscriptionHostSnapshot[];
  providers: MergedProvider[];
  /**
   * Latest audio-level/VAD reading per live session, from Transcription
   * Service's own index — deliberately NOT joined to `sessions` (D2 of
   * PLAN-AUDIOVIZ: the two publishers do not coordinate, and both
   * asymmetries are signals, not noise).
   */
  sessionAudio: SessionAudioSnapshot[];
}

/**
 * Sub-second delta pushed over `/fleet/stream` — a plain SSE `message` event
 * (no `event:` name to switch on; the `t` field is the discriminant). Only
 * the `session` variant has a writer today; an unrecognized `t` should be
 * ignored rather than treated as an error, so this stays forward-compatible
 * with a `node`/`provider` variant added later.
 */
export interface SessionStatusEvent {
  t: 'session';
  sessionUid: string;
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
  sourceMicrophoneActive?: boolean | null;
  /** Publish time, epoch ms, on the publisher's clock. */
  at: number;
}
export type FleetEvent = SessionStatusEvent;

// ---- Test audio devices (PLAN-TestAudioDevices §2, via the §3 BFF) ----
// Mirrors `DeviceState`, `GoodParams` and `FaultParams` from
// apps/test-audio-generator. Restated here rather than imported for the same
// reason the fleet mirrors above are: the generator is a server-side service
// with its own dependency graph, and the SPA only ever sees these shapes
// second-hand through the admin BFF.

export type TestAudioDeviceId = 'good' | 'fault';

/** Run state of one synthetic source. Kept loose in spirit but exhaustive here:
 *  unlike `HealthComponent.status` this drives a start/stop button, so a state
 *  the SPA does not know about must not silently read as "idle". */
export type TestAudioRunState = 'idle' | 'connecting' | 'streaming' | 'error';

/** Catalog id of a committed/generated speech fixture (§2.1). */
export type TestAudioClip = 'harvard' | 'apollo' | 'longform';

export type TestAudioNoiseType = 'none' | 'white' | 'brown';

/** Noise floor in dBFS. Five fixed levels rather than a continuum, per §2.1. */
export type TestAudioNoiseDb = -60 | -50 | -40 | -30 | -20;

/** Device 1 — clean speech with a level and a noise floor (§2.1). */
export interface TestAudioGoodParams {
  clip: TestAudioClip;
  /** −40 dB is below the ingress meter's silence floor; +20 dB drives the
   *  fixture into hard clipping. Both ends are meant to be reachable. */
  gainDb: number;
  noiseType: TestAudioNoiseType;
  noiseDb: TestAudioNoiseDb;
}

/** Device 2 — one knob per fault, independently settable (§2.2). All default
 *  to zero, so a `fault` device started untouched streams clean audio. */
export interface TestAudioFaultParams {
  /** 0..100 — hard-clip the waveform. */
  clipPct: number;
  /** 0..100 — probability a frame is repeated. */
  stutterPct: number;
  /** 0..100 — probability a frame is skipped. */
  dropPct: number;
  /** 1.0..3.0 — send-rate multiple ("too many frames"). */
  speedup: number;
  /** 0..100 — probability a frame is digital silence. */
  silencePct: number;
  /** 0..1 — DC bias added to the waveform. */
  dcOffset: number;
  /** 0..100 — probability of a bad-CRC / truncated frame. */
  corruptPct: number;
  /** 0..100 — probability of a wrong-sample-rate WAV header. */
  badHeaderPct: number;
  /** −5000..5000 ms — offset written into the frame's `sentAt`. */
  clockSkewMs: number;
}

interface TestAudioDeviceBase {
  /** A device token is set for this device. False means the deployment ran no
   *  provisioning for it — distinct from the feature being off entirely, which
   *  is `TestAudioStatus.available`. */
  configured: boolean;
  state: TestAudioRunState;
  /** The session the device found in its own room, once it has one. */
  sessionUid: string | null;
  roomName: string | null;
  startedAtMs: number | null;
  /** Epoch ms of the auto-stop. Every run expires (§2), so this is non-null
   *  whenever the device is running. */
  expiresAtMs: number | null;
  framesSent: number;
  /** Frames the fault engine altered. Always 0 for the `good` device. */
  framesFaulted: number;
  transcriptCount: number;
  lastTranscript: string | null;
  error: string | null;
}

export interface TestAudioGoodDevice extends TestAudioDeviceBase {
  deviceId: 'good';
  params: TestAudioGoodParams;
}

export interface TestAudioFaultDevice extends TestAudioDeviceBase {
  deviceId: 'fault';
  params: TestAudioFaultParams;
}

/** Discriminated on `deviceId`, which is what decides the shape of `params`. */
export type TestAudioDeviceState = TestAudioGoodDevice | TestAudioFaultDevice;

/**
 * `available: false` means `TEST_AUDIO_BASE_URL` is unset on the admin server,
 * i.e. this deployment never provisioned the devices — `devices` is then `[]`
 * and every mutation would 503. It is a deployment fact, not a failure, so it
 * is reported in the success envelope rather than thrown (§3).
 */
export interface TestAudioStatus {
  available: boolean;
  devices: TestAudioDeviceState[];
}

export interface StartTestAudioBody {
  params: TestAudioGoodParams | TestAudioFaultParams;
  /** Required, and capped server-side by `TEST_AUDIO_MAX_DURATION_SEC`
   *  (default 1800). The run auto-stops at expiry with no further instruction. */
  durationSec: number;
}

/** A PATCH carries only the knobs that moved — which knob was turned is the
 *  whole point of the audit row (§3). */
export type TestAudioParamsPatch =
  | Partial<TestAudioGoodParams>
  | Partial<TestAudioFaultParams>;

export interface RoomDetail {
  room: Room;
  devices: Device[];
}

export interface RegisterDeviceResult {
  deviceUid: string;
  activationCode: string;
  expiry: string;
}

export interface ReregisterDeviceResult {
  activationCode: string;
  expiry: string;
}

export interface ListRoomsQuery {
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface ListDevicesQuery {
  search?: string;
  active?: boolean;
  roomUid?: string;
  cursor?: string;
  limit?: number;
}

interface EnvelopeOk<T> {
  ok: true;
  data: T;
}
interface EnvelopeErr {
  ok: false;
  error: { code: string; message: string; requestId?: string };
}

type QueryValue = string | number | boolean | null | undefined | string[];

function toQueryString(params: Record<string, QueryValue>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) usp.append(k, item);
    } else {
      usp.set(k, String(v));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * Typed client for the admin BFF. It:
 * - always sends the session cookie (`credentials: 'include'`),
 * - attaches the CSRF token header on state-changing requests,
 * - unwraps the `{ ok, data }` envelope, throwing {@link ApiError} otherwise,
 * - invokes `onUnauthorized` on a 401 so the app can route to /login.
 *
 * The admin API key is NEVER present here — it lives only in the BFF.
 */
export class AdminApiClient {
  private _csrfToken = '';
  private _onUnauthorized: (() => void) | undefined;

  setCsrfToken(token: string): void {
    this._csrfToken = token;
  }

  setOnUnauthorized(cb: () => void): void {
    this._onUnauthorized = cb;
  }

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const isMutation = method !== 'GET';
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (isMutation) headers['x-csrf-token'] = this._csrfToken;

    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        credentials: 'include',
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError('NETWORK', 'Could not reach the admin server.', 0);
    }

    let json: EnvelopeOk<T> | EnvelopeErr | undefined;
    try {
      json = (await res.json()) as EnvelopeOk<T> | EnvelopeErr;
    } catch {
      json = undefined;
    }

    if (res.ok && json?.ok) {
      return json.data;
    }

    if (res.status === 401) {
      // Session expired / not authenticated. Let the app react (route to login).
      this._onUnauthorized?.();
    }

    if (res.ok) {
      // A 2xx status whose body isn't a valid `{ ok: true, data }` envelope
      // (unparseable JSON, or an unexpected `ok: false`). Distinct code so
      // callers can't mistake this for a real declared backend error.
      throw new ApiError(
        'INVALID_RESPONSE',
        'The server returned an unexpected response.',
        res.status,
      );
    }

    const err =
      json && !json.ok
        ? json.error
        : { code: 'UNKNOWN', message: 'The request failed.' };
    throw new ApiError(err.code, err.message, res.status, err.requestId);
  }

  // ---- Auth ----
  getAuthConfig(): Promise<AuthConfig> {
    return this._request('GET', '/auth/config');
  }
  me(): Promise<SessionInfo> {
    return this._request('GET', '/auth/me');
  }
  login(username: string, password: string): Promise<SessionInfo> {
    return this._request('POST', '/auth/login', { username, password });
  }
  logout(): Promise<null> {
    return this._request('POST', '/auth/logout');
  }

  // ---- Health ----
  health(): Promise<HealthReport> {
    return this._request('GET', '/health');
  }

  // ---- Config check ----
  configCheck(): Promise<ConfigCheckReport> {
    return this._request('GET', '/config-check');
  }

  // ---- Deployment versions ----
  /** Probes every container concurrently server-side, so this is one request
   *  whatever the stack's size. Separate from `configCheck` deliberately: the
   *  two answer different questions and neither should wait on the other's
   *  probes. */
  deploymentVersions(): Promise<DeploymentVersionsReport> {
    return this._request('GET', '/deployment-versions');
  }

  // ---- Demo caption room ----
  demoRoom(): Promise<DemoRoomStatus> {
    return this._request('GET', '/demo-room/status');
  }

  // ---- Fleet telemetry ----
  /** Throws `ApiError` with code `TELEMETRY_UNAVAILABLE` (REDIS_URL unset) or
   *  `TELEMETRY_DEGRADED` (a read failed) — never resolves to an empty
   *  snapshot for either case, since that would be indistinguishable from a
   *  fleet that is genuinely idle. */
  fleet(): Promise<FleetSnapshot> {
    return this._request('GET', '/fleet');
  }

  // ---- Test audio devices ----
  /** Never throws for an unconfigured deployment — see `TestAudioStatus`. */
  testAudio(): Promise<TestAudioStatus> {
    return this._request('GET', '/test-audio');
  }
  startTestAudio(
    deviceId: TestAudioDeviceId,
    body: StartTestAudioBody,
  ): Promise<TestAudioDeviceState> {
    return this._request(
      'POST',
      `/test-audio/${encodeURIComponent(deviceId)}/start`,
      body,
    );
  }
  stopTestAudio(deviceId: TestAudioDeviceId): Promise<TestAudioDeviceState> {
    return this._request(
      'POST',
      `/test-audio/${encodeURIComponent(deviceId)}/stop`,
    );
  }
  /** Retunes a **running** device without restarting the stream. A restart
   *  would lose the session, which defeats the point of the feature (§2). */
  updateTestAudioParams(
    deviceId: TestAudioDeviceId,
    params: TestAudioParamsPatch,
  ): Promise<TestAudioDeviceState> {
    return this._request(
      'PATCH',
      `/test-audio/${encodeURIComponent(deviceId)}/params`,
      params,
    );
  }

  // ---- Rooms ----
  listRooms(query: ListRoomsQuery = {}): Promise<Paginated<Room>> {
    return this._request(
      'GET',
      `/rooms/list${toQueryString(query as Record<string, QueryValue>)}`,
    );
  }
  getRoom(roomUid: string): Promise<Room> {
    return this._request('GET', `/rooms/get/${encodeURIComponent(roomUid)}`);
  }
  roomDetail(roomUid: string): Promise<RoomDetail> {
    return this._request('GET', `/rooms/detail/${encodeURIComponent(roomUid)}`);
  }
  createRoom(body: {
    name: string;
    timezone: string;
    autoSessionEnabled: boolean;
    sourceDeviceUids: string[];
  }): Promise<Room> {
    return this._request('POST', '/rooms/create', body);
  }
  updateRoom(body: { roomUid: string; name?: string }): Promise<Room> {
    return this._request('POST', '/rooms/update', body);
  }
  deleteRoom(roomUid: string): Promise<null> {
    return this._request('POST', '/rooms/delete', { roomUid });
  }
  addDeviceToRoom(body: {
    roomUid: string;
    deviceUid: string;
    asSource: boolean;
  }): Promise<null> {
    return this._request('POST', '/rooms/add-device', body);
  }
  removeDeviceFromRoom(deviceUid: string): Promise<null> {
    return this._request('POST', '/rooms/remove-device', { deviceUid });
  }
  setSourceDevice(body: { roomUid: string; deviceUid: string }): Promise<null> {
    return this._request('POST', '/rooms/set-source', body);
  }

  // ---- Devices ----
  listDevices(query: ListDevicesQuery = {}): Promise<Paginated<Device>> {
    return this._request(
      'GET',
      `/devices/list${toQueryString(query as Record<string, QueryValue>)}`,
    );
  }
  getDevice(deviceUid: string): Promise<Device> {
    return this._request(
      'GET',
      `/devices/get/${encodeURIComponent(deviceUid)}`,
    );
  }
  registerDevice(name: string): Promise<RegisterDeviceResult> {
    return this._request('POST', '/devices/register', { name });
  }
  reregisterDevice(deviceUid: string): Promise<ReregisterDeviceResult> {
    return this._request('POST', '/devices/reregister', { deviceUid });
  }
  updateDevice(body: { deviceUid: string; name?: string }): Promise<Device> {
    return this._request('POST', '/devices/update', body);
  }
  deleteDevice(deviceUid: string): Promise<null> {
    return this._request('POST', '/devices/delete', { deviceUid });
  }

  // ---- Schedules ----
  listSchedules(query: TimeRangeQuery): Promise<{ items: SessionSchedule[] }> {
    return this._request(
      'GET',
      `/schedules/list${toQueryString(query as unknown as Record<string, QueryValue>)}`,
    );
  }
  getSchedule(scheduleUid: string): Promise<SessionSchedule> {
    return this._request(
      'GET',
      `/schedules/get/${encodeURIComponent(scheduleUid)}`,
    );
  }
  createSchedule(body: CreateScheduleBody): Promise<SessionSchedule> {
    return this._request('POST', '/schedules/create', body);
  }
  updateSchedule(body: UpdateScheduleBody): Promise<SessionSchedule> {
    return this._request('POST', '/schedules/update', body);
  }
  deleteSchedule(scheduleUid: string): Promise<null> {
    return this._request('POST', '/schedules/delete', { scheduleUid });
  }

  // ---- Auto-session windows ----
  listAutoWindows(
    query: TimeRangeQuery,
  ): Promise<{ items: AutoSessionWindow[] }> {
    return this._request(
      'GET',
      `/auto-windows/list${toQueryString(query as unknown as Record<string, QueryValue>)}`,
    );
  }
  getAutoWindow(windowUid: string): Promise<AutoSessionWindow> {
    return this._request(
      'GET',
      `/auto-windows/get/${encodeURIComponent(windowUid)}`,
    );
  }
  createAutoWindow(body: CreateAutoWindowBody): Promise<AutoSessionWindow> {
    return this._request('POST', '/auto-windows/create', body);
  }
  updateAutoWindow(body: UpdateAutoWindowBody): Promise<AutoSessionWindow> {
    return this._request('POST', '/auto-windows/update', body);
  }
  deleteAutoWindow(windowUid: string): Promise<null> {
    return this._request('POST', '/auto-windows/delete', { windowUid });
  }

  // ---- Room schedule config (auto-session master switch) ----
  updateRoomScheduleConfig(body: {
    roomUid: string;
    autoSessionEnabled?: boolean;
  }): Promise<Room> {
    return this._request('POST', '/schedules/room-config', body);
  }

  // ---- Sessions ----
  getSession(sessionUid: string): Promise<Session> {
    return this._request(
      'GET',
      `/sessions/get/${encodeURIComponent(sessionUid)}`,
    );
  }
  listSessions(query: SessionsRangeQuery): Promise<{ items: Session[] }> {
    return this._request(
      'GET',
      `/sessions/list${toQueryString(query as unknown as Record<string, QueryValue>)}`,
    );
  }
  getActiveSession(roomUid: string): Promise<Session | null> {
    return this._request(
      'GET',
      `/sessions/active/${encodeURIComponent(roomUid)}`,
    );
  }
  getSessionJoinCode(sessionUid: string): Promise<SessionJoinCodeStatus> {
    return this._request(
      'GET',
      `/sessions/${encodeURIComponent(sessionUid)}/join-code`,
    );
  }
  createOnDemandSession(body: CreateOnDemandSessionBody): Promise<Session> {
    return this._request('POST', '/sessions/create-on-demand', body);
  }
  startSessionEarly(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/start-early', { sessionUid });
  }
  endSessionEarly(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/end-early', { sessionUid });
  }
  cancelSession(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/cancel', { sessionUid });
  }
  uncancelSession(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/uncancel', { sessionUid });
  }

  // ---- Audit ----
  listAudit(limit = 50): Promise<{ items: AuditRow[] }> {
    return this._request('GET', `/audit${toQueryString({ limit })}`);
  }
}

/** Shared singleton client. */
export const adminApi = new AdminApiClient();
