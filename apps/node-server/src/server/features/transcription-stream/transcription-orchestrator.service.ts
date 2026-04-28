import type { LongPollClient } from '@scribear/base-long-poll-client';
import type { WebSocketClient } from '@scribear/base-websocket-client';
import {
  type SESSION_CONFIG_STREAM_SCHEMA,
  type Session,
} from '@scribear/session-manager-schema';
import {
  TRANSCRIPTION_STREAM_SCHEMA,
  TranscriptionStreamClientMessageType,
} from '@scribear/transcription-service-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import { AudioFrameChannel } from './events/audio-frame.events.js';
import {
  SessionStatusChannel,
  type SessionStatusMessage,
} from './events/session-status.events.js';
import { TranscriptChannel } from './events/transcript.events.js';

type UpstreamClient = WebSocketClient<typeof TRANSCRIPTION_STREAM_SCHEMA>;
type SessionConfigPoll = LongPollClient<typeof SESSION_CONFIG_STREAM_SCHEMA>;

/**
 * Factory that returns a long-poll client tracking session config for the
 * given sessionUid. Injected so integration tests can swap in a stub that
 * resolves immediately with a fixed `Session`, while production wires this
 * to {@link LongPollClient} pointed at Session Manager's
 * `session-config-stream` endpoint.
 */
export type SessionConfigPollFactory = (
  sessionUid: string,
) => SessionConfigPoll;

interface SessionState {
  sourceCount: number;
  upstream: UpstreamClient;
  longPoll: SessionConfigPoll;
  audioUnsubscribe: () => void;
  /**
   * Last published `SessionStatus` snapshot, kept so we can suppress redundant
   * publishes (state changes that don't actually flip either flag) and so
   * `getStatus()` can return a stable view to newly-authenticating
   * connections without recomputing from sub-objects.
   */
  status: SessionStatusMessage;
}

/**
 * Singleton that owns one upstream transcription connection per active
 * session and bridges audio (in via {@link AudioFrameChannel}) and
 * transcripts (out via {@link TranscriptChannel}).
 *
 * Sticky URL routing pins all connections for a given sessionUid to one
 * Node Server instance, so the singleton state for a session is always
 * co-located with the source connections feeding it.
 *
 * Each session's upstream is opened lazily on the first source registration
 * and torn down when the source-connection ref count drops back to zero.
 * Client (receive-only) connections never call into the orchestrator; they
 * subscribe to {@link TranscriptChannel} directly.
 */
export class TranscriptionOrchestratorService {
  private _sessions = new Map<string, SessionState>();
  private _logger: AppDependencies['logger'];
  private _eventBus: AppDependencies['eventBusService'];
  private _transcriptionServiceClient: AppDependencies['transcriptionServiceClient'];
  private _sessionConfigPollFactory: SessionConfigPollFactory;
  private _transcriptionApiKey: string;

  constructor(
    logger: AppDependencies['logger'],
    eventBusService: AppDependencies['eventBusService'],
    transcriptionServiceClient: AppDependencies['transcriptionServiceClient'],
    sessionConfigPollFactory: SessionConfigPollFactory,
    transcriptionServiceClientConfig: AppDependencies['transcriptionServiceClientConfig'],
  ) {
    this._logger = logger;
    this._eventBus = eventBusService;
    this._transcriptionServiceClient = transcriptionServiceClient;
    this._sessionConfigPollFactory = sessionConfigPollFactory;
    this._transcriptionApiKey = transcriptionServiceClientConfig.apiKey;
  }

  /**
   * Register a source connection for a session. The first registration for a
   * session opens the upstream transcription connection and starts tracking
   * config via long-poll; subsequent registrations just bump the ref count.
   *
   * Returns an unregister function the caller MUST invoke when the source
   * connection closes. The upstream is torn down when the count returns to 0.
   */
  async registerSource(sessionUid: string): Promise<() => void> {
    let state = this._sessions.get(sessionUid);
    if (state === undefined) {
      state = await this._openSession(sessionUid);
      this._sessions.set(sessionUid, state);
    }
    state.sourceCount += 1;
    this._setStatus(sessionUid, state);
    return () => {
      this._unregisterSource(sessionUid);
    };
  }

  /**
   * Current connectivity snapshot for a session. Sessions that have never had
   * a source register (or whose last source has unregistered) are reported as
   * fully disconnected.
   *
   * Per-connection services call this once after a successful auth so a newly
   * authenticated client sees the current state without waiting for the next
   * transition.
   */
  getStatus(sessionUid: string): SessionStatusMessage {
    const state = this._sessions.get(sessionUid);
    if (state === undefined) {
      return {
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
      };
    }
    return state.status;
  }

  /**
   * Number of sessions currently holding open upstream connections. Exposed
   * primarily for readiness checks and tests.
   */
  get activeSessionCount(): number {
    return this._sessions.size;
  }

  /**
   * Recompute a session's status from its current state, comparing against
   * the last-published snapshot. Publishes only on transitions so subscribers
   * never see redundant identical messages back-to-back.
   */
  private _setStatus(sessionUid: string, state: SessionState): void {
    const next: SessionStatusMessage = {
      transcriptionServiceConnected: state.upstream.state === 'OPEN',
      sourceDeviceConnected: state.sourceCount > 0,
    };
    if (
      next.transcriptionServiceConnected ===
        state.status.transcriptionServiceConnected &&
      next.sourceDeviceConnected === state.status.sourceDeviceConnected
    ) {
      return;
    }
    state.status = next;
    this._eventBus.publish(SessionStatusChannel, next, sessionUid);
  }

  private async _openSession(sessionUid: string): Promise<SessionState> {
    const longPoll = this._sessionConfigPollFactory(sessionUid);
    const initial = await this._awaitFirstConfig(longPoll, sessionUid);

    const upstream = this._transcriptionServiceClient.transcriptionStream({
      params: { providerKey: initial.transcriptionProviderId },
    });

    const state: SessionState = {
      sourceCount: 0,
      upstream,
      longPoll,
      audioUnsubscribe: () => {
        // Replaced below once the audio bus subscription is established.
      },
      status: {
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
      },
    };

    upstream.on('message', (msg) => {
      this._eventBus.publish(
        TranscriptChannel,
        { final: msg.final, inProgress: msg.in_progress },
        sessionUid,
      );
    });
    upstream.on('error', (err) => {
      this._logger.error({ err, sessionUid }, 'upstream transcription error');
    });
    // Republish status on every upstream transition. The session is removed
    // from the map before teardown, so terminate-driven state changes don't
    // accidentally re-publish stale state.
    upstream.on('stateChange', () => {
      if (this._sessions.get(sessionUid) !== state) return;
      this._setStatus(sessionUid, state);
    });

    upstream.start();
    upstream.send({
      type: TranscriptionStreamClientMessageType.AUTH,
      api_key: this._transcriptionApiKey,
    });
    upstream.send({
      type: TranscriptionStreamClientMessageType.CONFIG,
      // Trusted by Session Manager when the session was created; the
      // upstream provider validates its own config schema on receipt.
      config: initial.transcriptionStreamConfig as never,
    });

    state.audioUnsubscribe = this._eventBus.subscribe(
      AudioFrameChannel,
      (frame) => {
        upstream.sendBinary(frame);
      },
      sessionUid,
    );

    longPoll.on('data', (session) => {
      // Future iteration: reconnect the upstream if `transcriptionProviderId`
      // changed, or push a new CONFIG message if only the config did. For
      // now we just log so the long-poll keeps the cursor advancing and we
      // can observe config-bump events in production.
      this._logger.info(
        { sessionUid, version: session.sessionConfigVersion },
        'session config changed (no-op)',
      );
    });

    return state;
  }

  private async _awaitFirstConfig(
    longPoll: SessionConfigPoll,
    sessionUid: string,
  ): Promise<Session> {
    return await new Promise<Session>((resolve, reject) => {
      const onData = (session: Session) => {
        longPoll.off('error', onError);
        resolve(session);
      };
      const onError = (err: Error) => {
        longPoll.off('data', onData);
        longPoll.close();
        this._logger.error(
          { err, sessionUid },
          'session-config long-poll error',
        );
        reject(err);
      };
      longPoll.once('data', onData);
      longPoll.once('error', onError);
      longPoll.start();
    });
  }

  private _unregisterSource(sessionUid: string): void {
    const state = this._sessions.get(sessionUid);
    if (state === undefined) return;
    state.sourceCount -= 1;
    if (state.sourceCount > 0) {
      this._setStatus(sessionUid, state);
      return;
    }

    // Drop the session from the map before tearing down so the upstream
    // stateChange listener installed in `_openSession` skips its publish path
    // and we can emit one authoritative final-status message ourselves.
    this._sessions.delete(sessionUid);
    state.audioUnsubscribe();
    state.longPoll.close();
    state.upstream.terminate(1000, 'no-more-sources');

    if (
      state.status.transcriptionServiceConnected ||
      state.status.sourceDeviceConnected
    ) {
      this._eventBus.publish(
        SessionStatusChannel,
        { transcriptionServiceConnected: false, sourceDeviceConnected: false },
        sessionUid,
      );
    }
  }
}
