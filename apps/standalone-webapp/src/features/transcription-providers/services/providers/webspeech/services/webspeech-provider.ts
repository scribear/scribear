// import type { MicrophoneService } from '@scribear/microphone-store';
import { BaseProviderInterface } from '../../base-provider-interface';
import type { ProviderInterface } from '../../provider-interface';
import {
  INITIAL_WEBSPEECH_STATUS,
  type WebspeechConfig,
} from '../config/webspeech-config';
import { WebspeechStatus } from '../types/webspeech-status';

interface MicrophoneServiceLike {
  activateMicrophone: () => void | Promise<void>;
}

/**
 * Transcription provider implementation built on the browser's Web Speech API
 * (`SpeechRecognition` / `webkitSpeechRecognition`). Handles continuous
 * recognition, interim results, automatic restarts after each recognition
 * session ends, and microphone mute/unmute by stopping or starting recognition.
 */
export class WebspeechProvider
  extends BaseProviderInterface<WebspeechStatus>
  implements ProviderInterface<WebspeechConfig, WebspeechStatus>
{
  private _muted = true;
  private _recognition: SpeechRecognition | null = null;
  private _finalizedResultCount = 0;
  private _providerIsStarted = false;
  private readonly _microphoneService: MicrophoneServiceLike;
  private _networkRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly _NETWORK_RETRY_MS = 3000;

  constructor(microphoneService: MicrophoneServiceLike) {
    super(INITIAL_WEBSPEECH_STATUS);
    this._microphoneService = microphoneService;
  }

  private _clearNetworkRetryTimer() {
    if (this._networkRetryTimer) {
      clearTimeout(this._networkRetryTimer);
      this._networkRetryTimer = null;
    }
  }

  private _handleResult(event: SpeechRecognitionEvent) {
    const { results } = event;

    for (let i = this._finalizedResultCount; i < results.length; i++) {
      const result = results.item(i);
      const alternative = result.item(0);
      if (result.isFinal) {
        this._appendFinalizedTranscription({ text: [alternative.transcript] });
        this._finalizedResultCount = i + 1;
      }
    }

    const inProgress: string[] = [];
    for (let i = this._finalizedResultCount; i < results.length; i++) {
      const result = results.item(i);
      const alternative = result.item(0);
      if (!result.isFinal) {
        inProgress.push(alternative.transcript);
      }
    }

    if (inProgress.length > 0) {
      this._replaceInProgressTranscription({ text: inProgress });
    }
  }

  private _handleError(event: SpeechRecognitionErrorEvent) {
    if (event.error === 'no-speech') {
      this._commitParagraphBreak();
      return;
    }

    if (event.error === 'network') {
      console.warn('Webspeech network error, reconnecting...', event);
      this._setStatus(WebspeechStatus.NETWORK_RETRYING);
      this._clearNetworkRetryTimer();
      this._networkRetryTimer = setTimeout(() => {
        this._networkRetryTimer = null;
        if (!this._recognition || this._muted) return;
        if (this.status !== WebspeechStatus.NETWORK_RETRYING) return;
        try {
          this._recognition.start();
          this._providerIsStarted = true;
          this._setStatus(WebspeechStatus.ACTIVE);
        } catch (error) {
          console.error('Failed to restart after network error', error);
          this._setStatus(WebspeechStatus.ERROR);
        }
      }, WebspeechProvider._NETWORK_RETRY_MS);
      return;
    }

    console.error('Webspeech encountered unexpected error', event);
    this._setStatus(WebspeechStatus.ERROR);
  }

  private _handleEnd() {
    this._finalizedResultCount = 0;
    this._providerIsStarted = false;

    if (this.status === WebspeechStatus.ACTIVE && this._recognition) {
      try {
        this._recognition.start();
        this._providerIsStarted = true;
      } catch (error) {
        console.error('Failed to restart webspeech recognition', error);
      }
    }
  }

  private _createRecognition(config: WebspeechConfig) {
    const Recognition =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      window.SpeechRecognition || window.webkitSpeechRecognition;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!Recognition) {
      return null;
    }

    const recognition = new Recognition();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = config.languageTag;

    recognition.onresult = this._handleResult.bind(this);
    recognition.onerror = this._handleError.bind(this);
    recognition.onend = this._handleEnd.bind(this);

    return recognition;
  }

  private _startProvider() {
    if (!this._recognition) return;
    this._clearNetworkRetryTimer();

    try {
      this._recognition.start();
      this._providerIsStarted = true;
      this._setStatus(WebspeechStatus.ACTIVE);
    } catch (error) {
      console.error('Failed to start webspeech recognition', error);
      this._setStatus(WebspeechStatus.ERROR);
    }
  }

  private _pauseProvider() {
    if (!this._recognition) return;

    if (this._providerIsStarted) {
      this._recognition.stop();
      this._providerIsStarted = false;
    }

    this._setStatus(WebspeechStatus.ACTIVE_MUTE);
  }

  /**
   * Initializes a `SpeechRecognition` session with the given config and starts
   * or pauses it based on the current mute state. Sets status to `UNSUPPORTED`
   * if the browser does not implement the Web Speech API.
   *
   * @param config - The language tag to pass to `SpeechRecognition`.
   */
  activateProvider(config: WebspeechConfig) {
    this._setStatus(WebspeechStatus.ACTIVATING);

    try {
      this._recognition = this._createRecognition(config);
    } catch (error) {
      console.error('Failed to activate webspeech', error);
      this._setStatus(WebspeechStatus.ERROR);
      return;
    }

    if (this._recognition === null) {
      this._setStatus(WebspeechStatus.UNSUPPORTED);
      return;
    }

    if (this._muted) {
      this._pauseProvider();
    } else {
      this._startProvider();
    }
    void this._microphoneService.activateMicrophone();
  }

  /**
   * Stops recognition, resets status to `INACTIVE`, and releases the recognition object.
   */
  deactivateProvider() {
    this._clearNetworkRetryTimer();
    this._setStatus(WebspeechStatus.INACTIVE);
    if (this._recognition) {
      // Detach handlers before stopping so the async `onend` does not
      // trigger a restart attempt against the next recognition instance.
      this._recognition.onresult = null;
      this._recognition.onerror = null;
      this._recognition.onend = null;
      if (this._providerIsStarted) {
        this._recognition.stop();
      }
    }
    this._providerIsStarted = false;
    this._recognition = null;
  }

  /**
   * Clears the muted flag and resumes recognition if the provider is currently paused.
   */
  unmute() {
    this._muted = false;
    if (this.status === WebspeechStatus.ACTIVE_MUTE) {
      this._startProvider();
    }
  }

  /**
   * Sets the muted flag and stops recognition if it is currently running.
   */
  mute() {
    this._muted = true;
    if (this.status === WebspeechStatus.ACTIVE) {
      this._setStatus(WebspeechStatus.ACTIVE_MUTE);
      this._pauseProvider();
    }
  }
}
