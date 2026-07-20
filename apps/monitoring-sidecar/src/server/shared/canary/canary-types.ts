import type { AccuracyScore } from '#src/server/shared/canary/transcript-accuracy.js';

/**
 * How a canary run ended.
 *
 * The distinction between "the pipeline is broken" and "there was nothing to
 * test" matters: a canary that reports failure whenever no session is scheduled
 * would be red all night and would train operators to ignore it.
 */
export enum CanaryOutcome {
  /** Audio streamed and transcripts came back. */
  OK = 'ok',
  /** Audio streamed but no transcript ever arrived — the headline failure. */
  NO_TRANSCRIPTS = 'no-transcripts',
  /** Could not mint a session token. Points at session-manager or the device. */
  AUTH_FAILED = 'auth-failed',
  /** The WebSocket never reached an authenticated open state. */
  CONNECT_FAILED = 'connect-failed',
  /** Node accepted us but never reported an upstream transcription link. */
  UPSTREAM_DOWN = 'upstream-down',
  /** No active session to attach to. Not a failure; the canary stays quiet. */
  NO_SESSION = 'no-session',
  /** Anything unexpected. Carries the error message. */
  ERROR = 'error',
}

/** Outcomes that mean the pipeline is genuinely unhealthy. */
export const FAILING_OUTCOMES: readonly CanaryOutcome[] = [
  CanaryOutcome.NO_TRANSCRIPTS,
  CanaryOutcome.AUTH_FAILED,
  CanaryOutcome.CONNECT_FAILED,
  CanaryOutcome.UPSTREAM_DOWN,
  CanaryOutcome.ERROR,
];

/** Everything one canary run observed. Serialized straight onto the API. */
export interface CanaryRunResult {
  outcome: CanaryOutcome;
  startedAtMs: number;
  durationMs: number;
  sessionUid: string | null;
  /** Failure detail when the outcome is not OK. */
  error: string | null;

  /**
   * Time from the first audio frame to the first transcript word. The plan's
   * primary A2 assertion ("first transcript < N s"). Null when none arrived.
   */
  timeToFirstTranscriptMs: number | null;
  /** Transcript messages received. */
  transcriptCount: number;
  /** Audio frames actually put on the wire. */
  chunksSent: number;
  /**
   * Concatenated finalized transcript text, used for scoring.
   *
   * Safe to expose despite the §10.4 "no transcript content in telemetry"
   * rule: this is the canary reading a committed public-domain fixture to
   * itself, never a real speaker. No participant audio reaches this field.
   */
  transcriptText: string;

  /** Null when there was no transcript to score or no ground truth configured. */
  accuracy: AccuracyScore | null;
  /** Duplicate-word fraction; high values are the Whisper looping signature. */
  repetitionRatio: number | null;

  /** Skew-free node-side latency samples, summarized. */
  pipelineMsP50: number | null;
  pipelineMsP95: number | null;
  /**
   * End-to-end latency including capture and uplink. Null when clock sync never
   * converged — which is itself the §3 C6 signal, not a missing measurement.
   */
  e2eMsP95: number | null;
  /** Whether any `timeSyncPong` produced a usable offset (§3 C6). */
  clockSyncEstablished: boolean;

  /** Last `sessionStatus` seen from the node. */
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
  /** WebSocket close codes seen during the run, for correlating with A1. */
  closeCodes: number[];
}
