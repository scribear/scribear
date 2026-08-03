"""
Unit tests for ConfigMessageSchema's session_uid/room_uid tolerance
"""

from src.webserver.features.transcription_stream.transcription_stream_messages import (
    ClientJsonMessageAdapter,
)


def test_config_message_parses_with_session_and_room_uid_present():
    """
    A node server that sends session_uid/room_uid validates, and the values
    reach the parsed message unchanged.
    """
    # Arrange / Act
    parsed = ClientJsonMessageAdapter.validate_python(
        {
            "type": "config",
            "config": {"sample_rate": 48_000},
            "session_uid": "session-1",
            "room_uid": "room-1",
        }
    )

    # Assert
    assert parsed.session_uid == "session-1"
    assert parsed.room_uid == "room-1"


def test_config_message_parses_with_session_and_room_uid_absent():
    """
    An older node server that predates these fields still validates, with
    both defaulting to None rather than failing.
    """
    # Arrange / Act
    parsed = ClientJsonMessageAdapter.validate_python(
        {"type": "config", "config": {"sample_rate": 48_000}}
    )

    # Assert
    assert parsed.session_uid is None
    assert parsed.room_uid is None


def test_config_message_parses_with_session_and_room_uid_null():
    """
    Explicit JSON null (as opposed to an omitted key) also validates.
    """
    # Arrange / Act
    parsed = ClientJsonMessageAdapter.validate_python(
        {
            "type": "config",
            "config": {"sample_rate": 48_000},
            "session_uid": None,
            "room_uid": None,
        }
    )

    # Assert
    assert parsed.session_uid is None
    assert parsed.room_uid is None
