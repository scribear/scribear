"""
ScribeAR Audio Frame Protocol (SAFP) - Python decoder/encoder.

Mirrors the TypeScript implementation in
``libs/audio-frame-protocol``. A frame is a versioned, self-describing
binary envelope carrying a chunk of source audio plus a few metadata
fields, so the kiosk, node server, and transcription service can evolve
independently. Unknown fields are skipped via their length, the ``version``
byte guards structural changes, and a trailing CRC-32 (``zlib.crc32``,
identical to the TypeScript table) catches truncation or mis-framing.

Wire layout (all multi-byte integers little-endian):

    offset 0   magic[0]     uint8  = 0x53 ('S')
    offset 1   magic[1]     uint8  = 0x41 ('A')
    offset 2   version      uint8  = 1
    offset 3   field_count  uint8
    offset 4.. fields[field_count], each:
                 key         uint8
                 wire_type   uint8
                 length      uint16 (byte length of value)
                 value       length bytes
    ...        audio payload (all remaining bytes up to the CRC)
    last 4     crc32        uint32  CRC-32 over every byte before it
"""

import struct
import zlib
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

SAFP_MAGIC_0 = 0x53  # 'S'
SAFP_MAGIC_1 = 0x41  # 'A'
SAFP_VERSION = 1

# Field keys (see SafpFieldKey in the TypeScript implementation)
FIELD_KEY_SENT_AT = 1
FIELD_KEY_CHUNK_ID = 2
# Depth in the audio-telemetry graph at which the *sender* already measured
# this audio, so the transcription service's own ingress stage can continue
# that graph instead of restarting it at depth 1 (plan §12.2). No producer
# writes it yet - node-server is the intended one, since it is the first hop
# that could meter before the service sees the frame - but the decoder has to
# understand it before a producer can start sending it to a deployed reader.
FIELD_KEY_STAGE_DEPTH = 3

# Wire types (see SafpWireType in the TypeScript implementation)
WIRE_UINT = 0x01
WIRE_FLOAT64 = 0x02
WIRE_BYTES = 0x03
WIRE_UTF8 = 0x04

_HEADER_PREFIX_BYTES = 4  # magic(2) + version(1) + field_count(1)
_CRC_BYTES = 4
_FIELD_HEADER_BYTES = 4  # key(1) + wire_type(1) + length(2)
_MAX_FIELD_LEN = 0xFFFF
# Widest WIRE_UINT value this decoder will interpret. Longer is not an error
# in the envelope - the field is simply kept as an unknown one, the same
# treatment a key from a newer sender gets, so a future widening of the type
# cannot make an older reader reject the frame.
_MAX_UINT_BYTES = 8


class AudioFrameError(Exception):
    """Raised when a buffer is not a valid SAFP frame."""


@dataclass
class DecodedAudioFrame:
    """
    Result of decoding a SAFP frame.

    Attributes:
        version         - Envelope version byte
        chunk_id        - Correlation id, or None if absent
        sent_at         - Node-domain send timestamp in ms, or None if absent
        stage_depth     - Audio-telemetry graph depth the sender measured at,
                          or None if the sender does not meter
        audio           - Raw audio payload bytes
        unknown_fields  - (key, wire_type, value) tuples not recognised by
                          this decoder, preserved for forward compatibility
    """

    version: int
    chunk_id: Optional[str]
    sent_at: Optional[float]
    audio: bytes
    stage_depth: Optional[int] = None
    unknown_fields: List[Tuple[int, int, bytes]] = field(default_factory=list)


def encode_audio_frame(
    chunk_id: str,
    audio: bytes,
    sent_at: Optional[float] = None,
    stage_depth: Optional[int] = None,
) -> bytes:
    """
    Encode an audio chunk and its metadata into a SAFP frame.

    Args:
        chunk_id    - Correlation id, always written
        audio       - Raw audio payload bytes
        sent_at     - Optional node-domain send timestamp in ms
        stage_depth - Optional audio-telemetry graph depth the sender measured
                        at. Written as a single-byte WIRE_UINT: a pipeline deep
                        enough to overflow one byte is not a pipeline anyone is
                        drawing.

    Returns:
        The encoded frame bytes.
    """
    fields = bytearray()
    field_count = 0

    chunk_bytes = chunk_id.encode("utf-8")
    if len(chunk_bytes) > _MAX_FIELD_LEN:
        raise AudioFrameError(f"chunk_id too long ({len(chunk_bytes)} bytes)")
    fields += struct.pack(
        "<BBH", FIELD_KEY_CHUNK_ID, WIRE_UTF8, len(chunk_bytes)
    )
    fields += chunk_bytes
    field_count += 1

    if sent_at is not None:
        value = struct.pack("<d", sent_at)
        fields += struct.pack(
            "<BBH", FIELD_KEY_SENT_AT, WIRE_FLOAT64, len(value)
        )
        fields += value
        field_count += 1

    if stage_depth is not None:
        if not 0 <= stage_depth <= 0xFF:
            raise AudioFrameError(f"stage_depth out of range ({stage_depth})")
        fields += struct.pack("<BBH", FIELD_KEY_STAGE_DEPTH, WIRE_UINT, 1)
        fields += struct.pack("<B", stage_depth)
        field_count += 1

    body = bytearray()
    body += struct.pack(
        "<BBBB", SAFP_MAGIC_0, SAFP_MAGIC_1, SAFP_VERSION, field_count
    )
    body += fields
    body += audio

    crc = zlib.crc32(bytes(body)) & 0xFFFFFFFF
    body += struct.pack("<I", crc)
    return bytes(body)


def decode_audio_frame(data: bytes) -> DecodedAudioFrame:
    # pylint: disable=too-many-locals
    """
    Decode a SAFP frame, verifying magic, version, and CRC-32.

    Args:
        data    - Raw frame bytes

    Returns:
        A DecodedAudioFrame with the metadata and audio payload.

    Raises:
        AudioFrameError - if the buffer is too short, has a bad magic, fails
            CRC, uses an unsupported version, or is structurally malformed.
    """
    if len(data) < _HEADER_PREFIX_BYTES + _CRC_BYTES:
        raise AudioFrameError(f"Frame too short ({len(data)} bytes)")
    if data[0] != SAFP_MAGIC_0 or data[1] != SAFP_MAGIC_1:
        raise AudioFrameError("Bad magic; not a SAFP frame")

    crc_offset = len(data) - _CRC_BYTES
    (expected,) = struct.unpack_from("<I", data, crc_offset)
    actual = zlib.crc32(data[:crc_offset]) & 0xFFFFFFFF
    if expected != actual:
        raise AudioFrameError("CRC mismatch; frame corrupted or truncated")

    version = data[2]
    if version != SAFP_VERSION:
        raise AudioFrameError(f"Unsupported SAFP version {version}")

    field_count = data[3]
    offset = _HEADER_PREFIX_BYTES
    chunk_id: Optional[str] = None
    sent_at: Optional[float] = None
    stage_depth: Optional[int] = None
    unknown_fields: List[Tuple[int, int, bytes]] = []

    for _ in range(field_count):
        if offset + _FIELD_HEADER_BYTES > crc_offset:
            raise AudioFrameError("Truncated field header")
        key = data[offset]
        wire_type = data[offset + 1]
        (length,) = struct.unpack_from("<H", data, offset + 2)
        value_start = offset + _FIELD_HEADER_BYTES
        value_end = value_start + length
        if value_end > crc_offset:
            raise AudioFrameError("Field value overruns frame")
        value = data[value_start:value_end]

        if key == FIELD_KEY_CHUNK_ID:
            chunk_id = value.decode("utf-8", errors="replace")
        elif key == FIELD_KEY_SENT_AT and length == 8:
            (sent_at,) = struct.unpack("<d", value)
        elif key == FIELD_KEY_STAGE_DEPTH and 1 <= length <= _MAX_UINT_BYTES:
            # Little-endian over whatever width the sender chose, rather than a
            # fixed uint8: WIRE_UINT is self-describing by length, and pinning
            # this reader to one byte would make a sender that widened the
            # field look like it had sent an unknown one.
            stage_depth = int.from_bytes(value, "little")
        else:
            unknown_fields.append((key, wire_type, value))

        offset = value_end

    audio = data[offset:crc_offset]
    return DecodedAudioFrame(
        version=version,
        chunk_id=chunk_id,
        sent_at=sent_at,
        audio=audio,
        stage_depth=stage_depth,
        unknown_fields=unknown_fields,
    )
