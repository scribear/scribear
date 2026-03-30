/**
 * Downsamples a Float32Array of audio samples from one sample rate to another
 * using linear interpolation.
 *
 * @param {Float32Array} samples - The input audio samples.
 * @param {number} sourceRate - The sample rate of the input samples in Hz.
 * @param {number} targetRate - The desired output sample rate in Hz.
 * @returns {Float32Array} The resampled audio data at the target sample rate.
 */
function downsample(samples, sourceRate, targetRate) {
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
 * Encodes a Float32Array of audio samples into a WAV file ArrayBuffer.
 * Samples are converted from 32-bit float to 16-bit PCM. The output
 * includes a standard 44-byte RIFF/WAVE header followed by the PCM data.
 *
 * @param {Float32Array} samples - The audio samples to encode, in the range [-1, 1].
 * @param {number} sampleRate - The sample rate of the audio in Hz.
 * @param {number} numChannels - The number of audio channels.
 * @returns {ArrayBuffer} A WAV-formatted ArrayBuffer ready for transmission or playback.
 */
function encodeWav(samples, sampleRate, numChannels) {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
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

/**
 * An AudioWorkletProcessor that accumulates raw audio input into a buffer,
 * downsamples it to a target sample rate, encodes it as WAV, and posts
 * each chunk to the main thread via the processor's message port.
 *
 * @extends AudioWorkletProcessor
 */
class AudioChunkProcessor extends AudioWorkletProcessor {
  /**
   * @param {AudioWorkletNodeOptions} options
   * @param {object} options.processorOptions
   * @param {number} options.processorOptions.bufferSize - Number of samples to accumulate before encoding and sending a chunk.
   * @param {number} options.processorOptions.targetSampleRate - Target sample rate in Hz for the output WAV data.
   * @param {number} options.processorOptions.numChannels - Number of audio channels to include in the WAV header.
   */
  constructor(options) {
    super();
    this._bufferSize = options.processorOptions.bufferSize;
    this._targetSampleRate = options.processorOptions.targetSampleRate;
    this._numChannels = options.processorOptions.numChannels;
    this._buffer = [];
  }

  /**
   * Called by the audio rendering engine for each block of audio data.
   * Appends the first channel of the first input to the internal buffer.
   * When the buffer reaches the configured size, it downsamples the chunk,
   * encodes it as WAV, and transfers it to the main thread.
   *
   * @param {Float32Array[][]} inputs - Array of inputs, each containing per-channel sample arrays.
   * @returns {boolean} Always returns true to keep the processor alive.
   */
  process(inputs) {
    const channel = inputs[0]?.[0];
    const frameCount = channel ? channel.length : 128;

    for (let i = 0; i < frameCount; i++) {
      this._buffer.push(channel ? (channel[i] ?? 0) : 0);
    }

    while (this._buffer.length >= this._bufferSize) {
      const raw = new Float32Array(this._buffer.splice(0, this._bufferSize));
      const resampled = downsample(raw, sampleRate, this._targetSampleRate);
      const wav = encodeWav(
        resampled,
        this._targetSampleRate,
        this._numChannels,
      );
      this.port.postMessage(wav, [wav]);
    }

    return true;
  }
}

registerProcessor('audio-chunk-processor', AudioChunkProcessor);
