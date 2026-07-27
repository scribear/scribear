import { describe, expect } from 'vitest';

import {
  WavFormatError,
  decodeWav,
  encodeWav,
  sliceIntoChunks,
} from '#src/wav.js';

const SAMPLE_RATE = 16_000;

/** Builds `frames` of 16-bit mono PCM with a recognisable ramp. */
function pcm(frames: number): Buffer {
  const buffer = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(i % 1000, i * 2);
  return buffer;
}

describe('wav', () => {
  describe('encodeWav / decodeWav', (it) => {
    it('round-trips PCM through a canonical header', () => {
      // Arrange
      const original = pcm(1_600);

      // Act
      const decoded = decodeWav(encodeWav(original, SAMPLE_RATE, 1));

      // Assert
      expect(decoded.sampleRate).toBe(SAMPLE_RATE);
      expect(decoded.channels).toBe(1);
      expect(decoded.pcm.equals(original)).toBe(true);
      expect(decoded.durationMs).toBeCloseTo(100, 5);
    });

    it('writes a 44-byte header, matching what a real source device sends', () => {
      // Arrange — the transcription service parses each frame as a standalone
      // audio file, so header layout is protocol, not an implementation detail.
      const wav = encodeWav(pcm(160), SAMPLE_RATE, 1);

      // Assert
      expect(wav.length).toBe(44 + 320);
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
      expect(wav.toString('ascii', 36, 40)).toBe('data');
      expect(wav.readUInt16LE(22)).toBe(1); // channels
      expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);
      expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    });

    it('finds the data chunk after an intervening LIST chunk', () => {
      // Arrange — ffmpeg (which produced the committed fixtures) often writes a
      // LIST/INFO chunk before `data`. Assuming a fixed offset of 44 would
      // slice that metadata into the audio and stream noise.
      const audio = pcm(320);
      const base = encodeWav(audio, SAMPLE_RATE, 1);
      const listChunk = Buffer.alloc(8 + 8);
      listChunk.write('LIST', 0, 'ascii');
      listChunk.writeUInt32LE(8, 4);
      listChunk.write('INFOxxxx', 8, 'ascii');
      const withList = Buffer.concat([
        base.subarray(0, 36),
        listChunk,
        base.subarray(36),
      ]);
      withList.writeUInt32LE(withList.length - 8, 4);

      // Act
      const decoded = decodeWav(withList);

      // Assert
      expect(decoded.pcm.equals(audio)).toBe(true);
    });

    it('rejects a non-WAV buffer', () => {
      // Act / Assert
      expect(() => decodeWav(Buffer.from('not audio at all'))).toThrow(
        WavFormatError,
      );
    });

    it('rejects non-PCM encodings rather than streaming garbage', () => {
      // Arrange — format tag 3 is IEEE float, which the canary cannot slice.
      const wav = encodeWav(pcm(160), SAMPLE_RATE, 1);
      wav.writeUInt16LE(3, 20);

      // Act / Assert
      expect(() => decodeWav(wav)).toThrow(/uncompressed PCM/);
    });
  });

  describe('sliceIntoChunks', (it) => {
    it('slices into realtime-sized chunks that are each a complete WAV', () => {
      // Arrange — 1 s of audio at 100 ms per chunk.
      const wav = decodeWav(encodeWav(pcm(SAMPLE_RATE), SAMPLE_RATE, 1));

      // Act
      const chunks = sliceIntoChunks(wav, 100);

      // Assert
      expect(chunks).toHaveLength(10);
      for (const chunk of chunks) {
        expect(chunk.durationMs).toBeCloseTo(100, 5);
        // Each chunk must independently decode: the receiver treats every
        // frame as its own file and has no cross-frame state.
        const decoded = decodeWav(chunk.wav);
        expect(decoded.sampleRate).toBe(SAMPLE_RATE);
        expect(decoded.pcm.length).toBe(3_200);
      }
    });

    it('preserves audio content and order across the slice boundary', () => {
      // Arrange
      const audio = pcm(SAMPLE_RATE);
      const wav = decodeWav(encodeWav(audio, SAMPLE_RATE, 1));

      // Act
      const rejoined = Buffer.concat(
        sliceIntoChunks(wav, 100).map((chunk) => decodeWav(chunk.wav).pcm),
      );

      // Assert
      expect(rejoined.equals(audio)).toBe(true);
    });

    it('emits a short final chunk instead of dropping the tail', () => {
      // Arrange — 250 ms at 100 ms per chunk leaves a 50 ms remainder. Dropping
      // it would silently cost the fixture's last words and depress the
      // accuracy score for a reason unrelated to pipeline health.
      const wav = decodeWav(encodeWav(pcm(4_000), SAMPLE_RATE, 1));

      // Act
      const chunks = sliceIntoChunks(wav, 100);

      // Assert
      expect(chunks).toHaveLength(3);
      expect(chunks[2]?.durationMs).toBeCloseTo(50, 5);
    });
  });
});
