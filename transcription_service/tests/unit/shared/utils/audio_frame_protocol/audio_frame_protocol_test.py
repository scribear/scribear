"""
Unit tests for the ScribeAR Audio Frame Protocol (SAFP) codec.
"""

import struct
import zlib

import pytest

from src.shared.utils.audio_frame_protocol import (
    SAFP_VERSION,
    AudioFrameError,
    decode_audio_frame,
    encode_audio_frame,
)
from src.shared.utils.audio_frame_protocol.audio_frame_protocol import (
    FIELD_KEY_CHUNK_ID,
    SAFP_MAGIC_0,
    SAFP_MAGIC_1,
    WIRE_BYTES,
    WIRE_UTF8,
)

AUDIO = bytes([0, 1, 2, 3, 250, 251, 252, 253])


def test_crc_known_answer_matches_typescript():
    """zlib.crc32 must produce the canonical CRC-32 check value, which is the
    same number the TypeScript table-based crc32 produces."""
    assert zlib.crc32(b"123456789") & 0xFFFFFFFF == 0xCBF43926


def test_round_trip_chunk_id_and_sent_at():
    """A frame with both metadata fields decodes back to the same values."""
    frame = encode_audio_frame("id-123", AUDIO, sent_at=1_700_000_000_123.0)
    decoded = decode_audio_frame(frame)

    assert decoded.version == SAFP_VERSION
    assert decoded.chunk_id == "id-123"
    assert decoded.sent_at == 1_700_000_000_123.0
    assert decoded.audio == AUDIO
    assert decoded.unknown_fields == []


def test_round_trip_chunk_id_only():
    """The node -> python hop carries chunk_id only (no sent_at)."""
    frame = encode_audio_frame("abc", AUDIO)
    decoded = decode_audio_frame(frame)

    assert decoded.chunk_id == "abc"
    assert decoded.sent_at is None
    assert decoded.audio == AUDIO


def test_unicode_chunk_id():
    """UTF-8 chunk ids round-trip byte-for-byte."""
    decoded = decode_audio_frame(encode_audio_frame("café-⛄-😀", AUDIO))
    assert decoded.chunk_id == "café-⛄-😀"


def test_empty_audio():
    """A frame may carry no audio payload."""
    decoded = decode_audio_frame(encode_audio_frame("x", b""))
    assert decoded.chunk_id == "x"
    assert decoded.audio == b""


def test_cross_language_frame_shape():
    """Encoded magic + version bytes match the documented envelope, so a
    frame from the TypeScript encoder decodes here and vice versa."""
    frame = encode_audio_frame("x", AUDIO)
    assert frame[0] == SAFP_MAGIC_0
    assert frame[1] == SAFP_MAGIC_1
    assert frame[2] == SAFP_VERSION


def test_forward_compatibility_skips_unknown_field():
    """An unknown field inserted by a newer sender is skipped, and the known
    field + audio are still recovered."""
    chunk_bytes = b"fwd"
    unknown_value = bytes([9, 9, 9])
    fields = bytearray()
    fields += struct.pack(
        "<BBH", FIELD_KEY_CHUNK_ID, WIRE_UTF8, len(chunk_bytes)
    )
    fields += chunk_bytes
    fields += struct.pack("<BBH", 99, WIRE_BYTES, len(unknown_value))
    fields += unknown_value

    body = bytearray()
    body += struct.pack("<BBBB", SAFP_MAGIC_0, SAFP_MAGIC_1, SAFP_VERSION, 2)
    body += fields
    body += AUDIO
    body += struct.pack("<I", zlib.crc32(bytes(body)) & 0xFFFFFFFF)

    decoded = decode_audio_frame(bytes(body))
    assert decoded.chunk_id == "fwd"
    assert decoded.audio == AUDIO
    assert len(decoded.unknown_fields) == 1
    assert decoded.unknown_fields[0][0] == 99


def test_rejects_short_buffer():
    """Buffers shorter than the minimum envelope are rejected."""
    with pytest.raises(AudioFrameError):
        decode_audio_frame(b"\x00\x00\x00")


def test_rejects_bad_magic():
    """A frame with the wrong magic is rejected."""
    frame = bytearray(encode_audio_frame("x", AUDIO))
    frame[0] = 0x00
    frame[-4:] = struct.pack("<I", zlib.crc32(bytes(frame[:-4])) & 0xFFFFFFFF)
    with pytest.raises(AudioFrameError, match="magic"):
        decode_audio_frame(bytes(frame))


def test_rejects_crc_mismatch():
    """A single flipped audio byte is caught by the CRC."""
    frame = bytearray(encode_audio_frame("x", AUDIO))
    frame[-5] ^= 0xFF
    with pytest.raises(AudioFrameError, match="CRC"):
        decode_audio_frame(bytes(frame))


def test_rejects_unsupported_version():
    """An unexpected version byte is rejected."""
    frame = bytearray(encode_audio_frame("x", AUDIO))
    frame[2] = 2
    frame[-4:] = struct.pack("<I", zlib.crc32(bytes(frame[:-4])) & 0xFFFFFFFF)
    with pytest.raises(AudioFrameError, match="version"):
        decode_audio_frame(bytes(frame))
