"""
Cross-provider tests for `TranscriptionSessionInterface.admission_worker_id`
(PLAN-AdmissionControl.md §4/§5)

This is the one property that decides which providers capacity admission
applies to, so it is pinned here against all three shipped providers at once
rather than three times inside three provider suites. A test that only looked
at whisper would not notice a later provider quietly opting itself in, and it
is the *exclusions* that carry the risk: `lumen_granite` is a remote-API
provider whose capacity question is upstream rate limits and network latency
(explicitly deferred by §5/§7), and refusing one of its sessions because a
local worker looked busy would be a refusal derived from a measurement that
does not describe it.

Every session here is built over a mocked WorkerPool, so no model is loaded and
no worker process is spawned; what is being pinned is which worker id each
session reports, not what the pool does with it.
"""

from unittest.mock import MagicMock

import pytest

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobHandle, WorkerPool
from src.transcription_providers.debug_provider import DebugProvider
from src.transcription_providers.lumen_granite_provider import (
    LumenGraniteProvider,
)
from src.transcription_providers.whisper_streaming_provider import (
    WhisperStreamingProvider,
)

# The worker the mocked pool claims to have placed every job on. Deliberately
# not 0, so a session that reported a default instead of a real placement would
# fail rather than pass by coincidence - and not falsy, since `admission_worker_id`
# is checked against None specifically so that worker 0 is a valid answer.
ASSIGNED_WORKER_ID = 2

WHISPER_PROVIDER_CONFIG = {
    "whisper_context_tag": "whisper_context",
    "silero_context_tag": "silero_context",
    "job_period_ms": 1000,
    "max_buffer_len_sec": 20.0,
    "local_agree_dim": 2,
}

DEBUG_SESSION_CONFIG = {"sample_rate": 16000, "num_channels": 1}


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for tests
    """
    return MagicMock(spec=Logger)


@pytest.fixture
def mock_worker_pool():
    """
    A pool whose register_job hands back a handle reporting a real worker id
    """
    handle = MagicMock(spec=JobHandle)
    handle.worker_id = ASSIGNED_WORKER_ID

    pool = MagicMock(spec=WorkerPool)
    pool.register_job.return_value = handle
    return pool


def test_whisper_session_reports_the_worker_its_job_landed_on(
    mock_logger: MagicMock, mock_worker_pool: MagicMock
):
    """
    Test the local ASR provider opts into capacity admission with a real worker

    Whisper streaming is the provider the estimator's per-worker busy fraction
    actually describes: its passes are the local compute that fills a worker's
    single job loop, and N sessions sharing one worker are what the whole
    `interval = N x C` collapse is made of. The id has to come off the handle
    `register_job` returned, because the pool picks the worker from live
    utilization at that moment - any re-derivation would be a guess about a
    decision already made.
    """
    # Arrange
    provider = WhisperStreamingProvider(
        WHISPER_PROVIDER_CONFIG, mock_logger, mock_worker_pool, "whisper"
    )

    # Act
    session = provider.create_session(
        "unused_config", "session-1", "room-1", mock_logger
    )

    # Assert
    assert session.admission_worker_id == ASSIGNED_WORKER_ID


def test_lumen_granite_session_is_excluded_from_capacity_admission(
    mock_logger: MagicMock, mock_worker_pool: MagicMock
):
    """
    Test the remote provider reports no admission worker, so it is never refused

    Note what this test is NOT asserting: that lumen registers no job. It does
    register one - with an empty context tag tuple, so `_assign_process` returns
    whichever worker was least utilized - and that job really does occupy the
    worker while its blocking HTTP POST is in flight. The exclusion is therefore
    a deliberate statement rather than an accident of it having no worker id
    available: the worker it landed on is not a placement onto the model that
    serves it, and the per-worker ASR capacity estimate says nothing about how
    many sessions NCSA Lumen will accept.

    Left as an explicit gap rather than a fabricated ceiling, matching §5's
    instruction to render "not applicable" rather than a fake number for this
    provider.
    """
    # Arrange
    provider = LumenGraniteProvider({}, mock_logger, mock_worker_pool, "lumen")

    # Act
    session = provider.create_session(
        "unused_config", "session-1", "room-1", mock_logger
    )

    # Assert
    assert session.admission_worker_id is None
    # Registration still happened - the exclusion is a decision, not an absence
    mock_worker_pool.register_job.assert_called_once()


def test_debug_session_is_excluded_from_capacity_admission(
    mock_logger: MagicMock, mock_worker_pool: MagicMock
):
    """
    Test the debug provider reports no admission worker

    Lower stakes than lumen (it is a dev/test provider and transcribes
    nothing), but decided rather than assumed: it too registers a job with an
    empty context tag tuple, and its per-pass cost - reporting how long its own
    decode took - is not the local ASR compute the estimator's `b` is measured
    from. Refusing a debug session because a whisper session had filled the
    worker would break the one provider an operator reaches for when they are
    trying to work out whether the pipeline works at all.
    """
    # Arrange
    provider = DebugProvider({}, mock_logger, mock_worker_pool, "debug")

    # Act
    session = provider.create_session(
        DEBUG_SESSION_CONFIG, "session-1", "room-1", mock_logger
    )

    # Assert
    assert session.admission_worker_id is None
    mock_worker_pool.register_job.assert_called_once()
