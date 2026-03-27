import { EventEmitter } from 'eventemitter3';

import { tryCatch } from '#src/utils/try-catch';

export interface AudioStream {
  audioContext: AudioContext;
  workletNode: AudioWorkletNode;
  closed: boolean;
}

// AudioWorklet inline processor: buffers samples and posts chunks to main thread.
const PROCESSOR_CODE = `
class AudioChunkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._bufferSize = options.processorOptions.bufferSize;
    this._buffer = [];
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    const frameCount = channel ? channel.length : 128;

    for (let i = 0; i < frameCount; i++) {
      this._buffer.push(channel ? (channel[i] ?? 0) : 0);
    }

    while (this._buffer.length >= this._bufferSize) {
      const chunk = new Float32Array(this._buffer.splice(0, this._bufferSize));
      this.port.postMessage(chunk, [chunk.buffer]);
    }

    return true;
  }
}
registerProcessor('audio-chunk-processor', AudioChunkProcessor);
`;

/**
 * Downsample a Float32Array from one sample rate to another using linear interpolation.
 *
 * @param samples - Input samples at sourceRate.
 * @param sourceRate - Original sample rate in Hz.
 * @param targetRate - Desired output sample rate in Hz.
 * @returns Resampled Float32Array.
 */
function downsample(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate) return samples;

  const ratio = sourceRate / targetRate;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, samples.length - 1);
    const frac = srcIndex - low;
    result[i] = (samples[low] ?? 0) * (1 - frac) + (samples[high] ?? 0) * frac;
  }

  return result;
}

/**
 * Encode Float32 PCM samples into a WAV ArrayBuffer (16-bit PCM).
 *
 * @param samples - PCM samples in the range [-1.0, 1.0].
 * @param sampleRate - Sample rate in Hz.
 * @param numChannels - Number of audio channels.
 * @returns WAV-encoded ArrayBuffer.
 */
function encodeWav(
  samples: Float32Array,
  sampleRate: number,
  numChannels: number,
): ArrayBuffer {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(44 + i * bytesPerSample, int16, true);
  }

  return buffer;
}

interface MicrophoneServiceEvents {
  statusChange: (newStatus: MicrophoneServiceStatus) => void;
}

export enum MicrophoneServiceStatus {
  INACTIVE = 'INACTIVE',
  INFO_PROMPT = 'INFO_PROMPT',
  DENIED_PROMPT = 'DENIED_PROMPT',
  ACTIVATING = 'ACTIVATING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR',
}

class MicrophoneService extends EventEmitter<MicrophoneServiceEvents> {
  private _micStream: MediaStream | null;
  private _audioStreams = new Map<
    AudioStream,
    MediaStreamAudioSourceNode | null
  >();

  private _status: MicrophoneServiceStatus = MicrophoneServiceStatus.INACTIVE;
  get status() {
    return this._status;
  }

  private _setStatus(newStatus: MicrophoneServiceStatus) {
    this._status = newStatus;
    this.emit('statusChange', newStatus);
  }

  constructor() {
    super();
    this._micStream = null;

    // Update microphone state if permissions change while active
    void this._beginStatusChangeListener();
  }

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

  private async _checkPermission(): Promise<'granted' | 'prompt' | 'denied'> {
    const permissionStatus = await navigator.permissions.query({
      name: 'microphone',
    });
    return permissionStatus.state;
  }

  private async _getMicStream() {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    return micStream;
  }

  async activateMicrophone(): Promise<void> {
    if (
      this.status === MicrophoneServiceStatus.ACTIVATING ||
      this.status === MicrophoneServiceStatus.ACTIVE
    ) {
      return;
    }

    // Skip info prompt if this is retrying activation or already in info prompt
    const skipInfoPrompt =
      this.status === MicrophoneServiceStatus.INFO_PROMPT ||
      this.status === MicrophoneServiceStatus.DENIED_PROMPT ||
      this.status === MicrophoneServiceStatus.ERROR;

    this._setStatus(MicrophoneServiceStatus.ACTIVATING);

    // Check out current permissions
    const [initCheckError, initPermission] = await tryCatch(
      this._checkPermission(),
    );
    if (initCheckError) {
      console.error('Failed to check microphone permissioin', initCheckError);
      this._setStatus(MicrophoneServiceStatus.ERROR);
      return;
    }

    if (initPermission === 'prompt' && !skipInfoPrompt) {
      this._setStatus(MicrophoneServiceStatus.INFO_PROMPT);
      return;
    }
    if (initPermission === 'denied') {
      this._setStatus(MicrophoneServiceStatus.DENIED_PROMPT);
      return;
    }

    // If allowed, request mic from browser
    const [getMicStreamError, micStream] = await tryCatch(this._getMicStream());
    if (getMicStreamError) {
      // On failure to get mic, check if is because user denied access
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

  deactivateMicrophone() {
    if (this._micStream !== null) {
      const tracks = this._micStream.getTracks();
      tracks.forEach((track) => {
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
   * Creates a processed audio stream from the microphone and begins recording it.
   * Produces silence when the microphone is inactive, but the stream remains valid.
   * Each recorded chunk is delivered as a WAV ArrayBuffer at the given interval.
   * Call {@link closeAudioStream} with the returned stream when it is no longer needed.
   *
   * @param channels - Number of output audio channels (1 for mono, 2 for stereo).
   * @param sampleRate - Target audio sample rate in Hz.
   * @param timesliceMs - Interval in milliseconds between WAV chunks.
   * @param onChunk - Callback invoked with each WAV-encoded audio chunk.
   * @returns Promise resolving to an AudioStream handle for use with closeAudioStream.
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

    const blob = new Blob([PROCESSOR_CODE], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    await audioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    const workletNode = new AudioWorkletNode(
      audioContext,
      'audio-chunk-processor',
      { processorOptions: { bufferSize } },
    );

    const streamHandle: AudioStream = {
      audioContext,
      workletNode,
      closed: false,
    };

    workletNode.port.onmessage = (event: MessageEvent) => {
      if (streamHandle.closed || this._micStream === null) return;
      const raw = event.data as Float32Array;
      const resampled =
        nativeSampleRate !== sampleRate
          ? downsample(raw, nativeSampleRate, sampleRate)
          : raw;
      onChunk(encodeWav(resampled, sampleRate, channels));
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
   * Closes and releases resources for a stream obtained via {@link getAudioStream}.
   *
   * @param stream - The AudioStream returned by getAudioStream().
   */
  closeAudioStream(stream: AudioStream): void {
    stream.closed = true;
    this._audioStreams.get(stream)?.disconnect();
    this._audioStreams.delete(stream);
    stream.workletNode.disconnect();
    void stream.audioContext.close();
  }
}

export type { MicrophoneService };

// Create microphone service singleton
export const microphoneService = new MicrophoneService();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    microphoneService.removeAllListeners();
    microphoneService.deactivateMicrophone();
  });
}
