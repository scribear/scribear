import type { MicrophoneService } from '@scribear/microphone-store';

import { BaseProviderInterface } from '../../base-provider-interface';
import type { ProviderInterface } from '../../provider-interface';
import {
  INITIAL_STREAMTEXT_STATUS,
  type StreamtextConfig,
} from '../config/streamtext-config';
import { StreamtextStatus } from '../types/streamtext-status';

/**
 * Shape of the JSON response from the StreamText captions polling endpoint.
 */
interface StreamtextCaptionsResponse {
  lastPosition?: unknown;
  content?: unknown;
}

// Poll interval mirrors StreamText recognizer cadence.
const POLL_INTERVAL_MS = 1000;
const DISCONNECTED_FAILURE_THRESHOLD = 3;

/**
 * Transcription provider implementation for StreamText live captioning.
 * Polls the StreamText captions HTTP endpoint at a fixed interval and appends
 * returned text segments as finalized transcription. Does not use the
 * microphone; mute/unmute calls are no-ops. Automatically deactivates the
 * microphone when activated to avoid conflicting with other providers.
 */
export class StreamtextProvider
  extends BaseProviderInterface<StreamtextStatus>
  implements ProviderInterface<StreamtextConfig, StreamtextStatus>
{
  private _microphoneService;
  private _pollTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private _abortController: AbortController | null = null;
  private _isPolling = false;
  private _consecutiveFailureCount = 0;
  private _event = '';
  private _language = 'en';
  private _lastPosition = 0;

  constructor(microphoneService: MicrophoneService) {
    super(INITIAL_STREAMTEXT_STATUS);
    this._microphoneService = microphoneService;
  }

  private _resetSessionState(config: StreamtextConfig) {
    this._event = config.event.trim();
    this._language =
      config.language.trim() === '' ? 'en' : config.language.trim();
    this._lastPosition = Math.max(0, Math.floor(config.startPosition));
    this._consecutiveFailureCount = 0;
  }

  private _buildCaptionsUrl() {
    const searchParams = new URLSearchParams({
      event: this._event,
      last: this._lastPosition.toString(),
      language: this._language,
    });
    return `https://www.streamtext.net/captions?${searchParams.toString()}`;
  }

  // Use recursive timeout to avoid overlapping requests when network is slow.
  private _startPolling() {
    if (this._isPolling) return;
    this._isPolling = true;
    void this._pollOnce();
  }

  private _scheduleNextPoll() {
    if (!this._isPolling) return;
    this._pollTimeoutId = setTimeout(() => {
      void this._pollOnce();
    }, POLL_INTERVAL_MS);
  }

  private async _pollOnce() {
    if (!this._isPolling) return;

    this._abortController = new AbortController();

    try {
      const response = await fetch(this._buildCaptionsUrl(), {
        signal: this._abortController.signal,
      });
      if (!response.ok) {
        throw new Error(
          `StreamText captions request failed (${String(response.status)})`,
        );
      }

      const json = (await response.json()) as StreamtextCaptionsResponse;

      const parsedLastPosition = Number(json.lastPosition);
      if (Number.isFinite(parsedLastPosition)) {
        this._lastPosition = Math.max(0, Math.floor(parsedLastPosition));
      }

      const content = typeof json.content === 'string' ? json.content : '';
      if (content !== '') {
        this._appendFinalizedTranscription({ text: [content] });
      }

      this._consecutiveFailureCount = 0;
      if (
        this.status === StreamtextStatus.CONNECTING ||
        this.status === StreamtextStatus.DISCONNECTED
      ) {
        this._setStatus(StreamtextStatus.ACTIVE);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;

      this._consecutiveFailureCount += 1;

      // Auto-retry always continues => DISCONNECTED is a UI signal after repeated failures.
      if (this._consecutiveFailureCount >= DISCONNECTED_FAILURE_THRESHOLD) {
        this._setStatus(StreamtextStatus.DISCONNECTED);
      }

      console.error('Failed to poll StreamText captions', error);
    } finally {
      this._abortController = null;
      this._scheduleNextPoll();
    }
  }

  private _stopPolling() {
    this._isPolling = false;

    if (this._pollTimeoutId !== null) {
      clearTimeout(this._pollTimeoutId);
      this._pollTimeoutId = null;
    }
    if (this._abortController !== null) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  /**
   * Starts polling the StreamText captions endpoint with the given config.
   * Returns early if already connecting or active. Sets status to `ERROR`
   * when the event name is empty.
   *
   * @param config - StreamText event, language, and start position to use.
   */
  activateProvider(config: StreamtextConfig) {
    if (
      this.status === StreamtextStatus.CONNECTING ||
      this.status === StreamtextStatus.ACTIVE
    ) {
      return;
    }

    // Always mute the mic because it's a no-op in this provider.
    this._microphoneService.deactivateMicrophone();

    if (config.event.trim() === '') {
      this._setStatus(StreamtextStatus.ERROR);
      return;
    }

    this._resetSessionState(config);
    this._setStatus(StreamtextStatus.CONNECTING);
    this._startPolling();
  }

  /**
   * Stops polling, cancels any in-flight request, and resets all session state.
   */
  deactivateProvider() {
    this._stopPolling();

    this._event = '';
    this._language = 'en';
    this._lastPosition = 0;
    this._consecutiveFailureCount = 0;
    this._setStatus(StreamtextStatus.INACTIVE);
  }

  /**
   * No-op - StreamText does not use microphone input.
   */
  unmute() {
    // StreamText does not use microphone input; muting is a no-op.
    return;
  }

  /**
   * No-op - StreamText does not use microphone input.
   */
  mute() {
    // StreamText does not use microphone input; muting is a no-op.
    return;
  }
}
