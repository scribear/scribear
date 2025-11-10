"""
Integration tests for /transcription_stream endpoint
"""

import asyncio
import logging
import re
from os import path
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from src.shared.config import (
    Config,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
from src.shared.logger import ContextLogger, Logger
from src.webserver.create_webserver import create_webserver

API_KEY = "TEST_KEY"
TIMEOUT_SEC = 1

AUDIO_DIR = path.normpath(
    path.join(__file__, "..", "..", "..", "..", "..", "test_audio_files/chords")
)


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for testing
    """
    underlying_logger = MagicMock(spec=logging.Logger)
    underlying_logger.level = 10
    return ContextLogger(underlying_logger)


@pytest.fixture
def mock_config():
    """
    Create mock config object for testing
    """
    mock = MagicMock(spec=Config)

    mock.api_key = API_KEY
    mock.ws_init_timeout_sec = TIMEOUT_SEC
    mock.provider_config.num_workers = 2
    mock.provider_config.providers = [
        TranscriptionProviderConfigSchema(
            provider_key="debug",
            provider_uid=TranscriptionProviderUID.DEBUG,
            provider_config=None,
        )
    ]
    return mock


@pytest_asyncio.fixture
async def test_client(mock_config: Config, mock_logger: Logger):
    """
    Create fresh FastAPI test client for each test
    """
    with TestClient(create_webserver(mock_config, mock_logger)) as client:
        yield client


@pytest.mark.timeout(3)
@pytest.mark.asyncio
async def test_transcription_stream_disconnects_on_timeout(
    test_client: TestClient,
):
    """
    Test that transcription stream websocket disconnects if auth/config messages are not received
    """
    # Arrange / Act / Assert
    with test_client.websocket_connect(
        "/transcription_stream/debug"
    ) as websocket:
        await asyncio.sleep(TIMEOUT_SEC + 0.1)

        with pytest.raises(WebSocketDisconnect):
            websocket.receive_text()


@pytest.mark.timeout(3)
@pytest.mark.asyncio
async def test_transcription_stream_rejects_invalid_auth(
    test_client: TestClient,
):
    """
    Test that transcription stream websocket disconnects if auth/config messages are not received
    """
    # Arrange / Act / Assert
    with test_client.websocket_connect(
        "/transcription_stream/debug"
    ) as websocket:
        websocket.send_json({"type": "auth", "api_key": "NOT_KEY"})

        # Allow async loop to run
        await asyncio.sleep(1)

        with pytest.raises(WebSocketDisconnect):
            websocket.receive_text()


@pytest.mark.timeout(3)
@pytest.mark.asyncio
async def test_transcription_stream_accepts_valid_auth_config(
    test_client: TestClient,
):
    """
    Test that transcription stream websocket disconnects if auth/config messages are not received
    """
    # Arrange / Act / Assert
    with test_client.websocket_connect(
        "/transcription_stream/debug"
    ) as websocket:
        websocket.send_json({"type": "auth", "api_key": API_KEY})
        websocket.send_json(
            {
                "type": "config",
                "config": {"sample_rate": 16000, "num_channels": 1},
            }
        )

        # Allow async loop to run
        await asyncio.sleep(1)

        received = websocket.receive_json()
        assert received == {
            "text": [
                "Session sample rate: 16000. ",
                "Session channel count: 1. ",
            ],
            "starts": None,
            "ends": None,
            "type": "final_transcript",
        }


@pytest.mark.timeout(5)
@pytest.mark.asyncio
async def test_transcription_stream_accepts_audio(test_client: TestClient):
    """
    Test that transcription stream websocket disconnects if auth/config messages are not received
    """
    # Arrange /
    with open(path.join(AUDIO_DIR, "mono_f64le.wav"), "rb") as f:
        chunk = f.read()

        # Act /
        with test_client.websocket_connect(
            "/transcription_stream/debug"
        ) as websocket:
            websocket.send_json({"type": "auth", "api_key": API_KEY})
            websocket.send_json(
                {
                    "type": "config",
                    "config": {"sample_rate": 48000, "num_channels": 1},
                }
            )
            websocket.send_bytes(chunk)
            websocket.receive_json()

            # Allow async loop to run
            await asyncio.sleep(3)

            received = websocket.receive_json()

            # Assert
            assert received["starts"] is None
            assert received["ends"] is None
            assert received["type"] == "ip_transcript"

            assert len(received["text"]) == 2
            assert received["text"][0] == "Processed 4.0000 seconds of audio. "
            decode_time = re.match(
                r"^Decode job took (\d+) nanoseconds. $", received["text"][1]
            )
            assert decode_time is not None
