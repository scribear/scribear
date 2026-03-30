import { EventEmitter } from 'eventemitter3';

import workletUrl from './audio-chunk-processor.worklet.js?url';

/**
 * Wraps a promise and returns a tuple of `[error, null]` on rejection
 * or `[null, value]` on resolution, avoiding try/catch at call sites.
 *
 * @template T - The resolved value type.
 * @template E - The error type, defaults to `Error`.
 * @param promise - The promise to wrap.
 * @returns A tuple where the first element is the error (or null) and the second is the value (or null).
 */
async function tryCatch<T, E = Error>(
  promise: Promise<T>,
): Promise<[E, null] | [null, T]> {
  try {
    const data = await promise;
    return [null, data];
  } catch (error) {
    return [error as E, null];
  }
}

/**
 * A handle representing an open audio stream created by {@link MicrophoneService.getAudioStream}.
 * Pass this to {@link MicrophoneService.closeAudioStream} to release resources when done.
 */
export interface AudioStream {
  audioContext: AudioContext;
  workletNode: AudioWorkletNode;
  closed: boolean;
}

/**
 * Event map for {@link MicrophoneService}.
 */
interface MicrophoneServiceEvents {
  /**
   * Fired whenever the service transitions to a new {@link MicrophoneServiceStatus}.
   */
  statusChange: (newStatus: MicrophoneServiceStatus) => void;
}

/**
 * Represents the possible runtime states of the {@link MicrophoneService}.
 *
 * - `INACTIVE` - the microphone is not in use.
 * - `INFO_PROMPT` - waiting for the user to acknowledge the mic permission prompt.
 * - `DENIED_PROMPT` - the user has denied microphone permission.
 * - `ACTIVATING` - the service is in the process of acquiring the mic stream.
 * - `ACTIVE` - the microphone is actively capturing audio.
 * - `ERROR` - an unexpected error occurred.
 */
export enum MicrophoneServiceStatus {
  INACTIVE = 'INACTIVE',
  INFO_PROMPT = 'INFO_PROMPT',
  DENIED_PROMPT = 'DENIED_PROMPT',
  ACTIVATING = 'ACTIVATING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR',
}

/**
 * Manages the browser microphone stream and distributes audio data to registered
 * {@link AudioStream} consumers.
 *
 * Audio is captured via the Web Audio API, buffered through an AudioWorklet,
 * downsampled to the requested sample rate, and delivered as WAV-encoded
 * `ArrayBuffer` chunks via a caller-provided callback.
 *
 * Emits `statusChange` events whenever the service's status transitions.
 */
export class MicrophoneService extends EventEmitter<MicrophoneServiceEvents> {
  /**
   * The active microphone MediaStream, or null when the mic is inactive.
   */
  private _micStream: MediaStream | null;

  /**
   * Maps each registered AudioStream handle to its MediaStreamAudioSourceNode,
   * or null if the mic is not currently active.
   */
  private _audioStreams = new Map<
    AudioStream,
    MediaStreamAudioSourceNode | null
  >();

  /**
   * The current status of the service, kept in sync with emitted statusChange events.
   */
  private _status: MicrophoneServiceStatus = MicrophoneServiceStatus.INACTIVE;

  /**
   * The current status of the microphone service.
   */
  get status() {
    return this._status;
  }

  /**
   * Updates the internal status and emits a `statusChange` event.
   * @param newStatus - The status to transition to.
   */
  private _setStatus(newStatus: MicrophoneServiceStatus) {
    this._status = newStatus;
    this.emit('statusChange', newStatus);
  }

  /**
   * Creates a new MicrophoneService and starts listening for permission changes.
   */
  constructor() {
    super();
    this._micStream = null;
    void this._beginStatusChangeListener();
  }

  /**
   * Subscribes to browser permission change events for the microphone.
   * If the permission is revoked while the mic is active, deactivates the mic
   * and transitions to the appropriate status.
   */
  private async _beginStatusChangeListener() {
    try {
      const permissionStatus = await navigator.permissions.query({
        name: 'microphone',
      });

      permissionStatus.onchange = () => {
        if (this._status !== MicrophoneServiceStatus.ACTIVE) return;

        if (permissionStatus.state === 'prompt') {
          this.deactivateMicrophone();
          this._setStatus(MicrophoneServiceStatus.INFO_PROMPT);
        } else if (permissionStatus.state === 'denied') {
          this.deactivateMicrophone();
          this._setStatus(MicrophoneServiceStatus.DENIED_PROMPT);
        } else {
          this._setStatus(MicrophoneServiceStatus.ERROR);
        }
      };
    } catch (error) {
      console.error('Failed to begin microphone status change listener', error);
      this._setStatus(MicrophoneServiceStatus.ERROR);
    }
  }

  /**
   * Queries the current microphone permission state from the Permissions API.
   * @returns A promise resolving to `'granted'`, `'prompt'`, or `'denied'`.
   */
  private async _checkPermission(): Promise<'granted' | 'prompt' | 'denied'> {
    const permissionStatus = await navigator.permissions.query({
      name: 'microphone',
    });
    return permissionStatus.state;
  }

  /**
   * Requests the user's microphone via `getUserMedia`.
   * @returns A promise resolving to the captured {@link MediaStream}.
   */
  private async _getMicStream() {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  /**
   * Requests microphone access and begins capturing audio.
   * Handles permission prompts, denial, and stream acquisition errors by
   * transitioning to the appropriate {@link MicrophoneServiceStatus}.
   * No-op if the service is already ACTIVATING or ACTIVE.
   */
  async activateMicrophone(): Promise<void> {
    if (
      this.status === MicrophoneServiceStatus.ACTIVATING ||
      this.status === MicrophoneServiceStatus.ACTIVE
    ) {
      return;
    }

    const previousStatus = this.status;
    this._setStatus(MicrophoneServiceStatus.ACTIVATING);

    const [initCheckError, initPermission] = await tryCatch(
      this._checkPermission(),
    );
    if (initCheckError) {
      console.error('Failed to check microphone permission', initCheckError);
      this._setStatus(MicrophoneServiceStatus.ERROR);
      return;
    }

    // Skip info prompt if this is retrying activation or already in info prompt
    const skipInfoPrompt =
      previousStatus === MicrophoneServiceStatus.INFO_PROMPT ||
      previousStatus === MicrophoneServiceStatus.DENIED_PROMPT ||
      previousStatus === MicrophoneServiceStatus.ERROR;
    if (initPermission === 'prompt' && !skipInfoPrompt) {
      this._setStatus(MicrophoneServiceStatus.INFO_PROMPT);
      return;
    }
    if (initPermission === 'denied') {
      this._setStatus(MicrophoneServiceStatus.DENIED_PROMPT);
      return;
    }

    const [getMicStreamError, micStream] = await tryCatch(this._getMicStream());
    if (getMicStreamError) {
      const [finalCheckError, finalPermission] = await tryCatch(
        this._checkPermission(),
      );
      if (!finalCheckError && finalPermission === 'denied') {
        this._setStatus(MicrophoneServiceStatus.DENIED_PROMPT);
        return;
      }

      console.error('Failed to activate microphone', getMicStreamError);
      this._setStatus(MicrophoneServiceStatus.ERROR);
      return;
    }

    this._micStream = micStream;

    for (const [stream, oldSource] of this._audioStreams) {
      oldSource?.disconnect();
      const source = stream.audioContext.createMediaStreamSource(micStream);
      source.connect(stream.workletNode);
      this._audioStreams.set(stream, source);
    }

    this._setStatus(MicrophoneServiceStatus.ACTIVE);
  }

  /**
   * Stops all microphone tracks, disconnects all registered audio stream sources,
   * and transitions the service to the INACTIVE status.
   */
  deactivateMicrophone() {
    if (this._micStream !== null) {
      this._micStream.getTracks().forEach((track) => {
        track.stop();
      });
      this._micStream = null;

      for (const [stream, source] of this._audioStreams) {
        source?.disconnect();
        this._audioStreams.set(stream, null);
      }
    }

    this._setStatus(MicrophoneServiceStatus.INACTIVE);
  }

  /**
   * Creates and registers an audio stream that delivers WAV-encoded audio chunks
   * to `onChunk` at the specified sample rate and interval.
   *
   * @param channels - The number of audio channels (1 for mono, 2 for stereo).
   * @param sampleRate - The target sample rate in Hz; audio is downsampled if needed.
   * @param timesliceMs - The approximate duration of each chunk in milliseconds.
   * @param onChunk - Callback invoked with each WAV-encoded `ArrayBuffer` audio chunk.
   * @returns A promise that resolves to an {@link AudioStream} handle.
   */
  async getAudioStream(
    channels: 1 | 2,
    sampleRate: number,
    timesliceMs: number,
    onChunk: (data: ArrayBuffer) => void,
  ): Promise<AudioStream> {
    const audioContext = new AudioContext();
    const nativeSampleRate = audioContext.sampleRate;
    const bufferSize = Math.round((nativeSampleRate * timesliceMs) / 1000);

    await audioContext.audioWorklet.addModule(workletUrl);

    const workletNode = new AudioWorkletNode(
      audioContext,
      'audio-chunk-processor',
      {
        processorOptions: {
          bufferSize,
          targetSampleRate: sampleRate,
          numChannels: channels,
        },
      },
    );

    const streamHandle: AudioStream = {
      audioContext,
      workletNode,
      closed: false,
    };

    workletNode.port.onmessage = (event: MessageEvent) => {
      if (streamHandle.closed || this._micStream === null) return;
      onChunk(event.data as ArrayBuffer);
    };

    if (this._micStream !== null) {
      const source = audioContext.createMediaStreamSource(this._micStream);
      source.connect(workletNode);
      this._audioStreams.set(streamHandle, source);
    } else {
      this._audioStreams.set(streamHandle, null);
    }

    workletNode.connect(audioContext.destination);
    return streamHandle;
  }

  /**
   * Closes an audio stream, disconnecting its source node and releasing the
   * AudioContext. After calling this, the stream handle should no longer be used.
   * @param stream - The {@link AudioStream} handle returned by {@link getAudioStream}.
   */
  closeAudioStream(stream: AudioStream): void {
    stream.closed = true;
    this._audioStreams.get(stream)?.disconnect();
    this._audioStreams.delete(stream);
    stream.workletNode.disconnect();
    void stream.audioContext.close();
  }
}
