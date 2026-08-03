/**
 * ScribeAR Audio Frame Protocol (SAFP).
 *
 * A versioned, self-describing binary envelope for a single chunk of source
 * audio plus a small set of metadata fields. It replaces hard-coded byte
 * offsets so the kiosk, node server, and transcription service can evolve
 * independently: readers skip fields they do not recognise (via each field's
 * length), the `version` byte guards structural changes, and a trailing
 * CRC-32 catches truncation or mis-framing.
 *
 * Wire layout (all multi-byte integers little-endian):
 *
 *   offset 0   magic[0]     uint8  = 0x53 ('S')
 *   offset 1   magic[1]     uint8  = 0x41 ('A')
 *   offset 2   version      uint8  = 1
 *   offset 3   fieldCount   uint8
 *   offset 4.. fields[fieldCount], each:
 *                key        uint8   (see {@link SafpFieldKey}: 1 = sentAt,
 *                                     2 = chunkId, 3 = stageDepth)
 *                wireType   uint8   (see {@link SafpWireType})
 *                length     uint16  (byte length of value)
 *                value      length bytes
 *   ...        audio payload (all remaining bytes up to the CRC)
 *   last 4     crc32        uint32  CRC-32 over every byte before it
 *
 * Adding a new field keeps `version` at 1 (old readers skip it). Bump
 * `version` only when the envelope structure itself changes.
 */
import { crc32 } from './crc32.js';

export const SAFP_MAGIC_0 = 0x53; // 'S'
export const SAFP_MAGIC_1 = 0x41; // 'A'
export const SAFP_VERSION = 1;

/** Fixed size of the envelope prefix: magic(2) + version(1) + fieldCount(1). */
const HEADER_PREFIX_BYTES = 4;
/** Size of the trailing CRC-32. */
const CRC_BYTES = 4;
/** Per-field overhead: key(1) + wireType(1) + length(2). */
const FIELD_HEADER_BYTES = 4;
/** Widest WIRE_UINT value this decoder will interpret. Longer is not an
 *  error in the envelope - the field is simply kept as an unknown one, the
 *  same treatment a key from a newer sender gets, so a future widening of
 *  the type cannot make an older reader reject the frame. */
const MAX_UINT_BYTES = 8;

/**
 * Known metadata field keys. Unknown keys are preserved but ignored, so this
 * enum can grow without breaking older peers.
 */
export enum SafpFieldKey {
  /** `sentAt`: wall-clock send time in ms, already corrected into the node's
   *  clock domain by the sender (see time-sync). Optional. */
  SENT_AT = 1,
  /** `chunkId`: opaque correlation id echoed back with transcripts. */
  CHUNK_ID = 2,
  /** `stageDepth`: audio-telemetry graph depth the *sender* measured at, so
   *  a downstream metering stage can continue the numbering rather than
   *  restarting at 1 (plan §12.2). Optional; no producer writes it yet. */
  STAGE_DEPTH = 3,
}

/**
 * Self-describing wire types, so a generic decoder can interpret a value
 * without consulting the field registry.
 */
export enum SafpWireType {
  UINT = 0x01,
  FLOAT64 = 0x02,
  BYTES = 0x03,
  UTF8 = 0x04,
}

/** Metadata carried alongside an audio chunk when encoding. */
export interface AudioFrameFields {
  /** Correlation id; required in practice so transcripts can be matched back. */
  chunkId: string;
  /** Optional node-domain send timestamp (ms) for end-to-end latency. */
  sentAt?: number;
  /** Optional audio-telemetry graph depth the sender measured at (0-255). */
  stageDepth?: number;
}

/** A field the decoder did not recognise, kept verbatim for forward-compat. */
export interface UnknownAudioFrameField {
  key: number;
  wireType: number;
  value: Uint8Array;
}

/** Result of {@link decodeAudioFrame}. */
export interface DecodedAudioFrame {
  version: number;
  chunkId: string | null;
  sentAt: number | null;
  stageDepth: number | null;
  audio: Uint8Array;
  unknownFields: UnknownAudioFrameField[];
}

/** Thrown when a buffer is not a valid SAFP frame. */
export class AudioFrameError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AudioFrameError';
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Little-endian over whatever width the sender chose, rather than a fixed
 * uint8: WIRE_UINT is self-describing by length, and pinning this reader to
 * one byte would make a sender that widened the field look like it had sent
 * an unknown one.
 */
function readLittleEndianUint(value: Uint8Array): number {
  let result = 0;
  for (let i = value.length - 1; i >= 0; i--) {
    result = result * 0x100 + (value[i] ?? 0);
  }
  return result;
}

/**
 * Encode an audio chunk and its metadata into a SAFP frame.
 *
 * @param fields Metadata to embed. `chunkId` is always written; `sentAt` and
 *   `stageDepth` are written only when provided.
 * @param audio Raw audio payload (already in the wire format the provider
 *   expects, e.g. PCM/WAV bytes).
 * @returns A freshly allocated frame, tightly sized so `.buffer` is safe to
 *   hand to a WebSocket's binary send.
 */
export function encodeAudioFrame(
  fields: AudioFrameFields,
  audio: Uint8Array,
): Uint8Array {
  const chunkIdBytes = textEncoder.encode(fields.chunkId);

  const fieldBlocks: { key: number; wireType: number; value: Uint8Array }[] = [
    {
      key: SafpFieldKey.CHUNK_ID,
      wireType: SafpWireType.UTF8,
      value: chunkIdBytes,
    },
  ];

  if (fields.sentAt !== undefined) {
    const sentAtBytes = new Uint8Array(8);
    new DataView(sentAtBytes.buffer).setFloat64(0, fields.sentAt, true);
    fieldBlocks.push({
      key: SafpFieldKey.SENT_AT,
      wireType: SafpWireType.FLOAT64,
      value: sentAtBytes,
    });
  }

  if (fields.stageDepth !== undefined) {
    if (fields.stageDepth < 0 || fields.stageDepth > 0xff) {
      throw new AudioFrameError(
        `stageDepth out of range (${String(fields.stageDepth)})`,
      );
    }
    fieldBlocks.push({
      key: SafpFieldKey.STAGE_DEPTH,
      wireType: SafpWireType.UINT,
      value: new Uint8Array([fields.stageDepth]),
    });
  }

  let fieldsBytes = 0;
  for (const block of fieldBlocks) {
    if (block.value.length > 0xffff) {
      throw new AudioFrameError(
        `Field ${String(block.key)} value too long (${String(block.value.length)} bytes)`,
      );
    }
    fieldsBytes += FIELD_HEADER_BYTES + block.value.length;
  }

  const totalLength =
    HEADER_PREFIX_BYTES + fieldsBytes + audio.length + CRC_BYTES;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);

  frame[0] = SAFP_MAGIC_0;
  frame[1] = SAFP_MAGIC_1;
  frame[2] = SAFP_VERSION;
  frame[3] = fieldBlocks.length;

  let offset = HEADER_PREFIX_BYTES;
  for (const block of fieldBlocks) {
    frame[offset] = block.key;
    frame[offset + 1] = block.wireType;
    view.setUint16(offset + 2, block.value.length, true);
    frame.set(block.value, offset + FIELD_HEADER_BYTES);
    offset += FIELD_HEADER_BYTES + block.value.length;
  }

  frame.set(audio, offset);
  offset += audio.length;

  const checksum = crc32(frame.subarray(0, offset));
  view.setUint32(offset, checksum, true);

  return frame;
}

/**
 * Decode a SAFP frame. Verifies the magic, version, and CRC-32 before
 * returning the metadata and audio payload.
 *
 * @throws {AudioFrameError} if the buffer is too short, has a bad magic,
 *   fails CRC, uses an unsupported version, or is structurally malformed.
 */
export function decodeAudioFrame(
  input: Uint8Array | ArrayBuffer,
): DecodedAudioFrame {
  const bytes = toUint8Array(input);

  if (bytes.length < HEADER_PREFIX_BYTES + CRC_BYTES) {
    throw new AudioFrameError(
      `Frame too short (${String(bytes.length)} bytes)`,
    );
  }
  if (bytes[0] !== SAFP_MAGIC_0 || bytes[1] !== SAFP_MAGIC_1) {
    throw new AudioFrameError('Bad magic; not a SAFP frame');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const crcOffset = bytes.length - CRC_BYTES;
  const expected = view.getUint32(crcOffset, true);
  const actual = crc32(bytes.subarray(0, crcOffset));
  if (expected !== actual) {
    throw new AudioFrameError('CRC mismatch; frame corrupted or truncated');
  }

  const version = bytes[2] ?? 0;
  if (version !== SAFP_VERSION) {
    throw new AudioFrameError(`Unsupported SAFP version ${String(version)}`);
  }

  const fieldCount = bytes[3] ?? 0;
  let offset = HEADER_PREFIX_BYTES;
  let chunkId: string | null = null;
  let sentAt: number | null = null;
  let stageDepth: number | null = null;
  const unknownFields: UnknownAudioFrameField[] = [];

  for (let i = 0; i < fieldCount; i++) {
    if (offset + FIELD_HEADER_BYTES > crcOffset) {
      throw new AudioFrameError('Truncated field header');
    }
    const key = bytes[offset] ?? 0;
    const wireType = bytes[offset + 1] ?? 0;
    const length = view.getUint16(offset + 2, true);
    const valueStart = offset + FIELD_HEADER_BYTES;
    const valueEnd = valueStart + length;
    if (valueEnd > crcOffset) {
      throw new AudioFrameError('Field value overruns frame');
    }
    const value = bytes.subarray(valueStart, valueEnd);

    // The `as number` casts here are load-bearing even though
    // no-unnecessary-type-assertion flags them as redundant: removing them
    // makes `key` (a plain number) get compared against the enum's literal
    // member type instead, which trips @typescript-eslint/no-unsafe-enum-comparison.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    if (key === (SafpFieldKey.CHUNK_ID as number)) {
      chunkId = textDecoder.decode(value);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    } else if (key === (SafpFieldKey.SENT_AT as number) && length === 8) {
      sentAt = new DataView(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).getFloat64(0, true);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    } else if (key === (SafpFieldKey.STAGE_DEPTH as number)) {
      if (length >= 1 && length <= MAX_UINT_BYTES) {
        stageDepth = readLittleEndianUint(value);
      } else {
        unknownFields.push({ key, wireType, value });
      }
    } else {
      unknownFields.push({ key, wireType, value });
    }

    offset = valueEnd;
  }

  const audio = bytes.subarray(offset, crcOffset);

  return { version, chunkId, sentAt, stageDepth, audio, unknownFields };
}
