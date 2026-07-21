"""
Integration test for the lumen_granite provider over /transcription_stream.

Exercises the full WebSocket stack - auth, config, audio frames, transcript
replies - with a local HTTP stub standing in for Lumen's OpenAI-compatible
endpoint, so the worker subprocess makes a real HTTP request but nothing leaves
the machine.
"""

# Test fixtures necessarily mirror the other transcription_stream tests.
# pylint: disable=duplicate-code

import asyncio
import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from os import path
from threading import Thread
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from src.shared.config import (
    Config,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
from src.shared.logger import ContextLogger, Logger
from src.shared.utils.audio_frame_protocol import encode_audio_frame
from src.webserver.create_webserver import create_webserver

API_KEY = "TEST_KEY"
TIMEOUT_SEC = 1
UPSTREAM_KEY_ENV = "LUMEN_GRANITE_TEST_KEY"
STUB_TRANSCRIPT = "stub transcript"

AUDIO_DIR = path.normpath(
    path.join(__file__, "..", "..", "..", "..", "..", "test_audio_files/speech")
)


class _StubHandler(BaseHTTPRequestHandler):
    """Answers any POST with a fixed OpenAI-style transcription body."""

    def do_POST(self):  # pylint: disable=invalid-name
        """Handle the transcription POST (name mandated by the base class)."""
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        body = json.dumps({"text": STUB_TRANSCRIPT}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence the default stderr logging
        del args


@pytest.fixture(name="stub_server")
def stub_server_fixture():
    """Run a local Lumen stand-in on an ephemeral port for the test."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    yield f"http://{host}:{port}/v1"
    server.shutdown()
    server.server_close()


@pytest.fixture
def mock_logger():
    """Create a mocked logger instance for testing."""
    underlying_logger = MagicMock(spec=logging.Logger)
    underlying_logger.level = 10
    return ContextLogger(underlying_logger)


@pytest.fixture
def mock_config(stub_server: str):
    """Config with a single lumen_granite provider pointed at the stub."""
    mock = MagicMock(spec=Config)
    mock.api_key = API_KEY
    # Telemetry publishing off: a MagicMock's `redis_url` is otherwise a truthy
    # mock, which sends the lifespan into opening a Redis connection to a
    # nonsense URL and hangs startup.
    mock.redis_url = ""
    mock.ws_init_timeout_sec = TIMEOUT_SEC
    mock.provider_config.num_workers = 1
    mock.provider_config.contexts = []
    mock.provider_config.providers = {
        "lumen_granite": TranscriptionProviderConfigSchema(
            provider_uid=TranscriptionProviderUID.LUMEN_GRANITE,
            provider_config={
                "base_url": stub_server,
                "model": "granite-speech-4.1-2b-plus",
                "api_key_env": UPSTREAM_KEY_ENV,
                # Fast period, large window -> stays in_progress for the test.
                "job_period_ms": 300,
                "max_buffer_len_sec": 60,
            },
        )
    }
    return mock


@pytest_asyncio.fixture
async def test_client(mock_config: Config, mock_logger: Logger):
    """Create a fresh FastAPI test client with the upstream key in the env."""
    # Set before the app (and its worker subprocess) starts so the forked
    # worker inherits the key.
    os.environ[UPSTREAM_KEY_ENV] = "secret-token"
    try:
        with TestClient(create_webserver(mock_config, mock_logger)) as client:
            yield client
    finally:
        os.environ.pop(UPSTREAM_KEY_ENV, None)


@pytest.mark.timeout(10)
@pytest.mark.asyncio
async def test_lumen_granite_stream_returns_transcript(test_client: TestClient):
    """auth -> config -> audio yields the stub's transcript as in_progress."""
    with open(path.join(AUDIO_DIR, "harvard_16k_mono.wav"), "rb") as f:
        chunk = f.read()

    with test_client.websocket_connect(
        "/transcription_stream/lumen_granite"
    ) as websocket:
        websocket.send_json({"type": "auth", "api_key": API_KEY})
        websocket.send_json({"type": "config", "config": {}})
        websocket.send_bytes(encode_audio_frame("chunk-1", chunk))

        await asyncio.sleep(1)

        received = websocket.receive_json()

    assert received["type"] == "transcript"
    assert received["final"] is None
    assert received["in_progress"] is not None
    assert received["in_progress"]["text"] == [STUB_TRANSCRIPT]
    assert received["in_progress_chunk_ids"] == ["chunk-1"]
