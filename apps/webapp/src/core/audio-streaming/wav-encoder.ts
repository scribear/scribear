/**
 * Encodes raw PCM float32 samples into a WAV-format ArrayBuffer.
 *
 * The transcription service's AudioDecoder uses the `soundfile` library,
 * which requires a proper container format (WAV), not raw PCM bytes.
 */

/**
 * Convert a Float32Array of PCM samples to a WAV ArrayBuffer.
 *
 * @param samples   Float32 PCM samples (range -1.0 to 1.0)
 * @param sampleRate  Audio sample rate in Hz
 * @param numChannels Number of audio channels
 * @returns WAV-encoded ArrayBuffer ready to send over WebSocket
 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
  numChannels: number,
): ArrayBuffer {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // ChunkSize
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (PCM = 16)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
  view.setUint16(32, numChannels * bytesPerSample, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Convert float32 samples to int16
  const offset = headerSize;
  for (let i = 0; i < samples.length; i++) {
    // Clamp to [-1, 1] then scale to int16 range
    const raw = samples[i] ?? 0;
    const clamped = Math.max(-1, Math.min(1, raw));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset + i * bytesPerSample, int16, true);
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Downsample a Float32Array from one sample rate to another.
 * Uses simple linear interpolation.
 *
 * @param samples     Input samples at sourceSampleRate
 * @param sourceRate  Original sample rate (e.g. 48000)
 * @param targetRate  Desired sample rate (e.g. 16000)
 * @returns Downsampled Float32Array
 */
export function downsample(
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
