import type { MicrophoneService } from '#src/core/microphone/services/microphone-service';

import { BaseProviderInterface } from '../../base-provider-interface';
import type { ProviderInterface } from '../../provider-interface';
import {
  INITIAL_STREAMTEXT_STATUS,
  type StreamtextConfig,
} from '../config/streamtext-config';
import { StreamtextStatus } from '../types/streamtext-status';

interface StreamtextCaptionsResponse {
  lastPosition?: unknown;
  content?: unknown;
}

// Poll interval mirrors StreamText recognizer cadence.
const POLL_INTERVAL_MS = 1000;
const DISCONNECTED_FAILURE_THRESHOLD = 3;
const MAX_IN_PROGRESS_CHARS = 5000; //~800-1000 words

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
  private _inProgressText = '';
  private _inProgressTextDirty = false;

  constructor(microphoneService: MicrophoneService) {
    super(INITIAL_STREAMTEXT_STATUS);
    this._microphoneService = microphoneService;
  }

  private _resetSessionState(config: StreamtextConfig) {
    this._event = config.event.trim();
    this._language =
      config.language.trim() === '' ? 'en' : config.language.trim();
    this._lastPosition = Math.max(0, Math.floor(config.startPosition));
    this._inProgressText = '';
    this._consecutiveFailureCount = 0;
    this._inProgressTextDirty = false;
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
        this._inProgressText += content;
        if (this._inProgressText.length >= MAX_IN_PROGRESS_CHARS) {
          // StreamText is incremental-only; chunking avoids large one-shot commits on stop.
          this._appendFinalizedTranscription({
            text: [this._inProgressText],
          });
          this._inProgressText = '';
          this._inProgressTextDirty = false;
        } else {
          this._replaceInProgressTranscription({
            text: [this._inProgressText],
          });
          this._inProgressTextDirty = true;
        }
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

  private _flushInProgressAsFinalized() {
    //StreamText only yields incremental text, so we finalize the accumulated in-progress block on stop.
    if (this._inProgressText === '') return;
    if (this._inProgressTextDirty) return;

    this._appendFinalizedTranscription({
      text: [this._inProgressText],
    });
    this._inProgressText = '';
    this._inProgressTextDirty = false;
  }

  activateProvider(config: StreamtextConfig) {
    if (
      this.status === StreamtextStatus.CONNECTING ||
      this.status === StreamtextStatus.ACTIVE
    ) {
      return;
    }

    //always mute the mic because it's a no-op in this provider.
    this._microphoneService.deactivateMicrophone();

    if (config.event.trim() === '') {
      this._setStatus(StreamtextStatus.ERROR);
      return;
    }

    this._resetSessionState(config);
    this._setStatus(StreamtextStatus.CONNECTING);
    this._startPolling();
  }

  deactivateProvider() {
    this._stopPolling();
    this._flushInProgressAsFinalized();

    this._event = '';
    this._language = 'en';
    this._lastPosition = 0;
    this._consecutiveFailureCount = 0;
    this._setStatus(StreamtextStatus.INACTIVE);
  }

  unmute() {
    // StreamText does not use microphone input; muting is a no-op.
    return;
  }

  mute() {
    // StreamText does not use microphone input; muting is a no-op.
    return;
  }
}
