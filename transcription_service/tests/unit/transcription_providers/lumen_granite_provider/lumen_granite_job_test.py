"""
Unit tests for LumenGraniteProviderJob.

The job's `process_batch` is exercised directly (in-process) with `requests.post`
mocked, so the tests are hermetic and never touch the network or a worker
subprocess.
"""

import io
import logging
from unittest.mock import MagicMock

import numpy as np
import pytest
import requests
import soundfile as sf

from src.transcription_provider_interface import (
    AudioChunkPayload,
    TranscriptionClientError,
)
from src.transcription_providers.lumen_granite_provider.lumen_granite_config import (
    lumen_granite_config_adapter,
)
from src.transcription_providers.lumen_granite_provider.lumen_granite_job import (
    LumenGraniteProviderJob,
)

API_KEY_ENV = "LUMEN_TEST_KEY"

POST_TARGET = (
    "src.transcription_providers.lumen_granite_provider."
    "lumen_granite_job.requests.post"
)


def make_wav(seconds: float, sample_rate: int = 16000) -> bytes:
    """Encode `seconds` of silence as a mono 16-bit WAV and return the bytes."""
    samples = np.zeros(int(sample_rate * seconds), dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def make_config(**overrides):
    """Build a LumenGraniteProviderConfig pointed at a test env var."""
    base = {"api_key_env": API_KEY_ENV, "max_buffer_len_sec": 20}
    base.update(overrides)
    return lumen_granite_config_adapter.validate_python(base)


def fake_response(status_code=200, json_body=None, text="OK"):
    """Build a stand-in for a requests.Response."""
    resp = MagicMock(spec=requests.Response)
    resp.status_code = status_code
    resp.ok = 200 <= status_code < 300
    resp.text = text
    resp.json.return_value = json_body if json_body is not None else {}
    return resp


@pytest.fixture(name="log")
def log_fixture():
    """A logger stub that swallows calls."""
    return MagicMock(spec=logging.Logger)


@pytest.fixture(autouse=True)
def _set_key(monkeypatch):
    """Provide the upstream key for every test unless a test clears it."""
    monkeypatch.setenv(API_KEY_ENV, "secret-token")


def chunk(seconds: float, chunk_id: str, sample_rate: int = 16000):
    """Build an AudioChunkPayload wrapping `seconds` of silence."""
    return AudioChunkPayload(
        chunk_id=chunk_id, audio_bytes=make_wav(seconds, sample_rate)
    )


def test_empty_batch_makes_no_request(log, mocker):
    """No audio -> empty result and no upstream call."""
    post = mocker.patch(POST_TARGET)
    job = LumenGraniteProviderJob(make_config())

    result = job.process_batch(log, (), [])

    assert result.final is None
    assert result.in_progress is None
    post.assert_not_called()


def test_in_progress_while_window_filling(log, mocker):
    """A short window is surfaced as in_progress with its chunk id."""
    post = mocker.patch(
        POST_TARGET,
        return_value=fake_response(json_body={"text": "hello world"}),
    )
    job = LumenGraniteProviderJob(make_config())

    result = job.process_batch(log, (), [chunk(2.0, "c1")])

    assert result.final is None
    assert result.in_progress is not None
    assert result.in_progress.text == ["hello world"]
    assert result.in_progress_chunk_ids == ["c1"]
    # Auth + multipart are set correctly.
    _, kwargs = post.call_args
    assert kwargs["headers"]["Authorization"] == "Bearer secret-token"
    assert "file" in kwargs["files"]
    assert kwargs["data"]["model"] == "granite-speech-4.1-2b-plus"


def test_commit_to_final_when_window_full(log, mocker):
    """When buffered audio reaches the max, the transcript is committed."""
    mocker.patch(
        POST_TARGET,
        return_value=fake_response(json_body={"text": "final text"}),
    )
    job = LumenGraniteProviderJob(make_config(max_buffer_len_sec=5))

    # 6s of audio exceeds the 5s window -> commit.
    result = job.process_batch(log, (), [chunk(6.0, "big")])

    assert result.final is not None
    assert result.final.text == ["final text"]
    assert result.final_chunk_ids == ["big"]
    # in_progress is cleared so the client's running line does not duplicate.
    assert result.in_progress is not None
    assert result.in_progress.text == []


def test_window_resets_after_commit(log, mocker):
    """After a commit the next short window starts a fresh in_progress."""
    mocker.patch(
        POST_TARGET, return_value=fake_response(json_body={"text": "t"})
    )
    job = LumenGraniteProviderJob(make_config(max_buffer_len_sec=5))

    job.process_batch(log, (), [chunk(6.0, "first")])  # commit + reset
    result = job.process_batch(log, (), [chunk(1.0, "second")])

    assert result.final is None
    assert result.in_progress is not None
    # Only the post-reset chunk id is attributed to the new window.
    assert result.in_progress_chunk_ids == ["second"]


def test_bad_audio_raises_client_error(log, mocker):
    """A sample-rate mismatch surfaces as a client error, not a crash."""
    mocker.patch(POST_TARGET)
    job = LumenGraniteProviderJob(make_config())

    with pytest.raises(TranscriptionClientError):
        # 48kHz audio into a 16kHz decoder -> ValueError -> client error.
        job.process_batch(log, (), [chunk(1.0, "c1", sample_rate=48000)])


def test_missing_key_raises_client_error(log, mocker, monkeypatch):
    """No upstream key configured -> client error before any request."""
    monkeypatch.delenv(API_KEY_ENV, raising=False)
    post = mocker.patch(POST_TARGET)
    job = LumenGraniteProviderJob(make_config())

    with pytest.raises(TranscriptionClientError):
        job.process_batch(log, (), [chunk(1.0, "c1")])
    post.assert_not_called()


def test_upstream_401_raises_client_error(log, mocker):
    """A 401/403 from Lumen is a client (key) error."""
    mocker.patch(
        POST_TARGET, return_value=fake_response(status_code=401, text="nope")
    )
    job = LumenGraniteProviderJob(make_config())

    with pytest.raises(TranscriptionClientError):
        job.process_batch(log, (), [chunk(1.0, "c1")])


def test_upstream_500_raises_server_error(log, mocker):
    """A 5xx from Lumen is a server-side error (not a client error)."""
    mocker.patch(
        POST_TARGET, return_value=fake_response(status_code=500, text="boom")
    )
    job = LumenGraniteProviderJob(make_config())

    with pytest.raises(RuntimeError):
        job.process_batch(log, (), [chunk(1.0, "c1")])


def test_connection_error_raises_server_error(log, mocker):
    """A transport failure is a server-side error."""
    mocker.patch(POST_TARGET, side_effect=requests.ConnectionError("down"))
    job = LumenGraniteProviderJob(make_config())

    with pytest.raises(RuntimeError):
        job.process_batch(log, (), [chunk(1.0, "c1")])


def test_update_config_not_supported(log):
    """On-the-fly config updates are rejected."""
    job = LumenGraniteProviderJob(make_config())
    with pytest.raises(TranscriptionClientError):
        job.update_config(log, (), None)
