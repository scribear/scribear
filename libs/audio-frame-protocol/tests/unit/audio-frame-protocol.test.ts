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
});
