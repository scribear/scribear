import { describe, expect, it } from 'vitest';

import {
  AudioFrameError,
  SAFP_MAGIC_0,
  SAFP_MAGIC_1,
  SAFP_VERSION,
  SafpFieldKey,
  SafpWireType,
  crc32,
  decodeAudioFrame,
  encodeAudioFrame,
} from '#src/index.js';

const audio = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]);

describe('crc32', () => {
  it('matches the IEEE known-answer for "123456789"', () => {
    // 0xCBF43926 is the canonical CRC-32 check value; Python's zlib.crc32
    // produces the same number, guaranteeing cross-language agreement.
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it('is empty-safe', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('encodeAudioFrame / decodeAudioFrame', () => {
  it('round-trips chunkId + sentAt + audio', () => {
    const chunkId = crypto.randomUUID();
    const sentAt = 1_700_000_000_123;
    const frame = encodeAudioFrame({ chunkId, sentAt }, audio);
    const decoded = decodeAudioFrame(frame);

    expect(decoded.version).toBe(SAFP_VERSION);
    expect(decoded.chunkId).toBe(chunkId);
    expect(decoded.sentAt).toBe(sentAt);
    expect([...decoded.audio]).toEqual([...audio]);
    expect(decoded.unknownFields).toEqual([]);
  });

  it('round-trips a frame with no sentAt (node -> python hop)', () => {
    const chunkId = 'abc-123';
    const frame = encodeAudioFrame({ chunkId }, audio);
    const decoded = decodeAudioFrame(frame);

    expect(decoded.chunkId).toBe(chunkId);
    expect(decoded.sentAt).toBeNull();
    expect([...decoded.audio]).toEqual([...audio]);
  });

  it('round-trips stageDepth', () => {
    const chunkId = 'depth-123';
    const frame = encodeAudioFrame({ chunkId, stageDepth: 2 }, audio);
    const decoded = decodeAudioFrame(frame);

    expect(decoded.stageDepth).toBe(2);
  });

  it('decodes a frame with no stageDepth as null, not 0, since 0 is a legal depth', () => {
    const chunkId = 'no-depth';
    const frame = encodeAudioFrame({ chunkId }, audio);
    const decoded = decodeAudioFrame(frame);

    expect(decoded.stageDepth).toBeNull();
  });

  it('round-trips stageDepth 0, distinguishing it from absent', () => {
    const chunkId = 'zero-depth';
    const frame = encodeAudioFrame({ chunkId, stageDepth: 0 }, audio);
    const decoded = decodeAudioFrame(frame);

    expect(decoded.stageDepth).toBe(0);
  });

  it('rejects a stageDepth outside the single-byte range, matching the Python encoder', () => {
    expect(() =>
      encodeAudioFrame({ chunkId: 'x', stageDepth: 256 }, audio),
    ).toThrow(AudioFrameError);
    expect(() =>
      encodeAudioFrame({ chunkId: 'x', stageDepth: -1 }, audio),
    ).toThrow(AudioFrameError);
  });

  it('writes the documented magic and version', () => {
    const frame = encodeAudioFrame({ chunkId: 'x' }, audio);
    expect(frame[0]).toBe(SAFP_MAGIC_0);
    expect(frame[1]).toBe(SAFP_MAGIC_1);
    expect(frame[2]).toBe(SAFP_VERSION);
  });

  it('handles an empty audio payload', () => {
    const frame = encodeAudioFrame({ chunkId: 'x' }, new Uint8Array(0));
    const decoded = decodeAudioFrame(frame);
    expect(decoded.chunkId).toBe('x');
    expect(decoded.audio.length).toBe(0);
  });

  it('accepts an ArrayBuffer as input', () => {
    const frame = encodeAudioFrame({ chunkId: 'y' }, audio);
    const copy = frame.slice();
    const decoded = decodeAudioFrame(copy.buffer);
    expect(decoded.chunkId).toBe('y');
  });

  it('preserves unicode chunk ids', () => {
    const chunkId = 'café-⛄-😀';
    const decoded = decodeAudioFrame(encodeAudioFrame({ chunkId }, audio));
    expect(decoded.chunkId).toBe(chunkId);
  });
});

describe('forward compatibility', () => {
  it('skips an unknown field and still finds audio + known fields', () => {
    // Hand-build a frame with an extra unknown field (key 99) between the
    // known fields and the audio, mimicking a newer sender.
    const chunkId = 'fwd';
    const chunkBytes = new TextEncoder().encode(chunkId);
    const unknownValue = new Uint8Array([9, 9, 9]);
    const fields = new Uint8Array(
      4 + chunkBytes.length + (4 + unknownValue.length),
    );
    const fView = new DataView(fields.buffer);
    // field 1: chunkId
    fields[0] = SafpFieldKey.CHUNK_ID;
    fields[1] = SafpWireType.UTF8;
    fView.setUint16(2, chunkBytes.length, true);
    fields.set(chunkBytes, 4);
    // field 2: unknown key 99
    const o = 4 + chunkBytes.length;
    fields[o] = 99;
    fields[o + 1] = SafpWireType.BYTES;
    fView.setUint16(o + 2, unknownValue.length, true);
    fields.set(unknownValue, o + 4);

    const body = new Uint8Array(4 + fields.length + audio.length);
    body[0] = SAFP_MAGIC_0;
    body[1] = SAFP_MAGIC_1;
    body[2] = SAFP_VERSION;
    body[3] = 2; // two fields
    body.set(fields, 4);
    body.set(audio, 4 + fields.length);

    const frame = new Uint8Array(body.length + 4);
    frame.set(body, 0);
    new DataView(frame.buffer).setUint32(body.length, crc32(body), true);

    const decoded = decodeAudioFrame(frame);
    expect(decoded.chunkId).toBe(chunkId);
    expect([...decoded.audio]).toEqual([...audio]);
    expect(decoded.unknownFields).toHaveLength(1);
    expect(decoded.unknownFields[0]?.key).toBe(99);
  });

  it('still finds a known stageDepth alongside a field key it does not recognise', () => {
    // A future sender may add its own field ahead of stageDepth landing on
    // every peer; this proves the two co-exist rather than one masking the
    // other.
    const chunkId = 'mixed';
    const chunkBytes = new TextEncoder().encode(chunkId);
    const unknownValue = new Uint8Array([7, 7]);
    const stageDepthValue = new Uint8Array([4]);

    const fields = new Uint8Array(
      4 +
        chunkBytes.length +
        (4 + unknownValue.length) +
        (4 + stageDepthValue.length),
    );
    const fView = new DataView(fields.buffer);
    fields[0] = SafpFieldKey.CHUNK_ID;
    fields[1] = SafpWireType.UTF8;
    fView.setUint16(2, chunkBytes.length, true);
    fields.set(chunkBytes, 4);

    let o = 4 + chunkBytes.length;
    fields[o] = 200; // unrecognised key
    fields[o + 1] = SafpWireType.BYTES;
    fView.setUint16(o + 2, unknownValue.length, true);
    fields.set(unknownValue, o + 4);

    o += 4 + unknownValue.length;
    fields[o] = SafpFieldKey.STAGE_DEPTH;
    fields[o + 1] = SafpWireType.UINT;
    fView.setUint16(o + 2, stageDepthValue.length, true);
    fields.set(stageDepthValue, o + 4);

    const body = new Uint8Array(4 + fields.length + audio.length);
    body[0] = SAFP_MAGIC_0;
    body[1] = SAFP_MAGIC_1;
    body[2] = SAFP_VERSION;
    body[3] = 3; // three fields
    body.set(fields, 4);
    body.set(audio, 4 + fields.length);

    const frame = new Uint8Array(body.length + 4);
    frame.set(body, 0);
    new DataView(frame.buffer).setUint32(body.length, crc32(body), true);

    const decoded = decodeAudioFrame(frame);
    expect(decoded.chunkId).toBe(chunkId);
    expect(decoded.stageDepth).toBe(4);
    expect(decoded.unknownFields).toHaveLength(1);
    expect(decoded.unknownFields[0]?.key).toBe(200);
    expect([...decoded.audio]).toEqual([...audio]);
  });

  it('an old decoder that never learned about stageDepth still finds chunkId, sentAt, and audio in a frame that carries it', () => {
    // Stand-in for the pre-this-change TypeScript decoder: identical framing
    // loop, but only CHUNK_ID and SENT_AT are special-cased, so stageDepth's
    // bytes fall through to "unknown" exactly like any other field an old
    // reader has never heard of. This is the property that lets node-server
    // start sending stageDepth before every reader has been upgraded.
    function decodeWithoutStageDepthSupport(frame: Uint8Array): {
      chunkId: string | null;
      sentAt: number | null;
      audio: Uint8Array;
      unknownKeys: number[];
    } {
      const view = new DataView(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength,
      );
      const crcOffset = frame.length - 4;
      const fieldCount = frame[3] ?? 0;
      let offset = 4;
      let chunkId: string | null = null;
      let sentAt: number | null = null;
      const unknownKeys: number[] = [];

      for (let i = 0; i < fieldCount; i++) {
        const key = frame[offset] ?? 0;
        const length = view.getUint16(offset + 2, true);
        const valueStart = offset + 4;
        const valueEnd = valueStart + length;
        const value = frame.subarray(valueStart, valueEnd);

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        if (key === (SafpFieldKey.CHUNK_ID as number)) {
          chunkId = new TextDecoder('utf-8').decode(value);
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        } else if (key === (SafpFieldKey.SENT_AT as number) && length === 8) {
          sentAt = new DataView(
            value.buffer,
            value.byteOffset,
            value.byteLength,
          ).getFloat64(0, true);
        } else {
          unknownKeys.push(key);
        }

        offset = valueEnd;
      }

      return {
        chunkId,
        sentAt,
        audio: frame.subarray(offset, crcOffset),
        unknownKeys,
      };
    }

    const chunkId = 'old-reader';
    const sentAt = 42;
    const frame = encodeAudioFrame({ chunkId, sentAt, stageDepth: 5 }, audio);
    const result = decodeWithoutStageDepthSupport(frame);

    expect(result.chunkId).toBe(chunkId);
    expect(result.sentAt).toBe(sentAt);
    expect([...result.audio]).toEqual([...audio]);
    expect(result.unknownKeys).toEqual([SafpFieldKey.STAGE_DEPTH]);
  });
});

describe('validation', () => {
  it('rejects a short buffer', () => {
    expect(() => decodeAudioFrame(new Uint8Array(3))).toThrow(AudioFrameError);
  });

  it('rejects a bad magic', () => {
    const frame = encodeAudioFrame({ chunkId: 'x' }, audio);
    frame[0] = 0x00;
    // recompute CRC so we isolate the magic check
    new DataView(frame.buffer).setUint32(
      frame.length - 4,
      crc32(frame.subarray(0, frame.length - 4)),
      true,
    );
    expect(() => decodeAudioFrame(frame)).toThrow(/magic/i);
  });

  it('rejects a corrupted payload via CRC', () => {
    const frame = encodeAudioFrame({ chunkId: 'x' }, audio);
    const i = frame.length - 5;
    frame[i] = (frame[i] ?? 0) ^ 0xff; // flip a byte of audio
    expect(() => decodeAudioFrame(frame)).toThrow(/CRC/i);
  });

  it('rejects an unsupported version', () => {
    const frame = encodeAudioFrame({ chunkId: 'x' }, audio);
    frame[2] = 2;
    new DataView(frame.buffer).setUint32(
      frame.length - 4,
      crc32(frame.subarray(0, frame.length - 4)),
      true,
    );
    expect(() => decodeAudioFrame(frame)).toThrow(/version/i);
  });

  it('still validates CRC-32 once stageDepth is one of the fields covered by it', () => {
    const frame = encodeAudioFrame({ chunkId: 'x', stageDepth: 9 }, audio);
    // decodeAudioFrame throws on CRC mismatch, so a clean decode here is
    // proof the checksum was computed over the frame with the new field
    // included, not stale from before it landed.
    expect(() => decodeAudioFrame(frame)).not.toThrow();

    const i = frame.length - 5;
    frame[i] = (frame[i] ?? 0) ^ 0xff;
    expect(() => decodeAudioFrame(frame)).toThrow(/CRC/i);
  });
});

describe('stageDepth field key and wire type', () => {
  // A drift guard: if the Python and TypeScript implementations ever
  // disagree on the field key number or wire type for stageDepth, a frame
  // encoded by one and decoded by the other silently mis-parses instead of
  // failing loudly, so pin both constants here rather than trusting the two
  // files to stay in sync by inspection.
  it('keys stageDepth as field 3', () => {
    expect(SafpFieldKey.STAGE_DEPTH).toBe(3);
  });

  it('wire-types stageDepth as WIRE_UINT (0x01)', () => {
    expect(SafpWireType.UINT).toBe(0x01);
  });
});
