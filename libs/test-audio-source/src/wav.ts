/**
 * Minimal WAV reader/writer for synthetic source devices.
 *
 * A synthetic source must put bytes on the wire that are byte-for-byte the
 * shape a real source device sends. A real source is
 * `audio-chunk-processor.worklet.js`, which emits **one complete
 * 44-byte-header RIFF/WAVE file per chunk** — not a raw PCM stream and not one
 * long WAV. Anything else would exercise a code path production never takes,
 * so the synthetic source would be testing a fiction.
 *
 * Only the subset that fixture audio uses is supported: uncompressed PCM
 * (format 1), 16-bit samples. Everything else is rejected loudly at load time
 * rather than producing silence the operator would misread as a pipeline fault.
 */

/** Bytes in a canonical RIFF/WAVE header. */
const WAV_HEADER_BYTES = 44;
/** WAVE format tag for uncompressed integer PCM. */
const WAVE_FORMAT_PCM = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

/** Decoded PCM payload plus the format it was stored in. */
export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** Raw little-endian 16-bit PCM, header stripped. */
  pcm: Buffer;
  /** Playback duration of {@link pcm} in milliseconds. */
  durationMs: number;
}

/** Thrown when a buffer is not WAV a synthetic source can stream. */
export class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavFormatError';
  }
}

/**
 * Parses a WAV file into its PCM payload.
 *
 * Chunks are walked rather than assuming the payload starts at byte 44:
 * `ffmpeg` — which produced the committed fixtures — writes a `LIST`/`INFO`
 * chunk before `data` often enough that a fixed offset would slice the
 * metadata into the audio and stream noise.
 */
export function decodeWav(buffer: Buffer): DecodedWav {
  if (buffer.length < 12) {
    throw new WavFormatError('Buffer is too short to be a WAV file.');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new WavFormatError('Missing RIFF marker; not a WAV file.');
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavFormatError('Missing WAVE marker; not a WAV file.');
  }

  let sampleRate: number | undefined;
  let channels: number | undefined;
  let pcm: Buffer | undefined;

  // Walk the chunk list. Each chunk is an 4-byte id, a 4-byte little-endian
  // size, then that many bytes, padded to an even boundary.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = Math.min(bodyStart + chunkSize, buffer.length);

    if (chunkId === 'fmt ') {
      if (bodyEnd - bodyStart < 16) {
        throw new WavFormatError('Truncated fmt chunk.');
      }
      const audioFormat = buffer.readUInt16LE(bodyStart);
      if (audioFormat !== WAVE_FORMAT_PCM) {
        throw new WavFormatError(
          `Unsupported WAV encoding ${String(audioFormat)}; only uncompressed PCM is supported.`,
        );
      }
      channels = buffer.readUInt16LE(bodyStart + 2);
      sampleRate = buffer.readUInt32LE(bodyStart + 4);
      const bits = buffer.readUInt16LE(bodyStart + 14);
      if (bits !== BITS_PER_SAMPLE) {
        throw new WavFormatError(
          `Unsupported bit depth ${String(bits)}; only 16-bit PCM is supported.`,
        );
      }
    } else if (chunkId === 'data') {
      pcm = buffer.subarray(bodyStart, bodyEnd);
    }

    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (sampleRate === undefined || channels === undefined) {
    throw new WavFormatError('WAV file has no fmt chunk.');
  }
  if (pcm === undefined) {
    throw new WavFormatError('WAV file has no data chunk.');
  }

  const frameBytes = BYTES_PER_SAMPLE * channels;
  const frames = Math.floor(pcm.length / frameBytes);
  return {
    sampleRate,
    channels,
    // Trim any trailing partial frame so slicing never splits a sample.
    pcm: pcm.subarray(0, frames * frameBytes),
    durationMs: (frames / sampleRate) * 1000,
  };
}

/** Wraps raw 16-bit PCM in a canonical 44-byte RIFF/WAVE header. */
export function encodeWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** One chunk of the source loop, ready to be wrapped in a SAFP frame. */
export interface AudioChunk {
  /** A complete standalone WAV file, as a real source device emits. */
  wav: Buffer;
  /** Playback duration, used to pace the stream at realtime. */
  durationMs: number;
  /** Index within the loop, for logging and deterministic chunk ids. */
  index: number;
}

/**
 * Slices decoded PCM into fixed-duration chunks, each re-wrapped as its own WAV.
 *
 * A trailing remainder shorter than `chunkMs` is emitted as a final short
 * chunk rather than dropped: silently truncating the tail would cost the last
 * words of the fixture and depress the canary's accuracy score for a reason
 * that has nothing to do with the pipeline's health.
 */
export function sliceIntoChunks(
  wav: DecodedWav,
  chunkMs: number,
): AudioChunk[] {
  if (chunkMs <= 0) {
    throw new WavFormatError('Chunk duration must be positive.');
  }

  const frameBytes = BYTES_PER_SAMPLE * wav.channels;
  const framesPerChunk = Math.max(
    1,
    Math.round((wav.sampleRate * chunkMs) / 1000),
  );
  const bytesPerChunk = framesPerChunk * frameBytes;

  const chunks: AudioChunk[] = [];
  for (
    let offset = 0, index = 0;
    offset < wav.pcm.length;
    offset += bytesPerChunk, index++
  ) {
    const pcm = wav.pcm.subarray(offset, offset + bytesPerChunk);
    chunks.push({
      wav: encodeWav(pcm, wav.sampleRate, wav.channels),
      durationMs: (pcm.length / frameBytes / wav.sampleRate) * 1000,
      index,
    });
  }
  return chunks;
}
