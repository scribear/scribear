"""
Integration tests for the /metrics/status endpoint
"""

import asyncio
import logging
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
from src.transcription_providers.debug_provider.debug_provider import (
    DEBUG_JOB_PERIOD_MS,
)
from src.webserver.create_webserver import create_webserver

API_KEY = "TEST_KEY"
METRICS_API_KEY = "TEST_METRICS_KEY"
TIMEOUT_SEC = 1

# Two real worker processes are spawned per test using these fixtures, which
# is well past the global 1s pytest timeout.
pytestmark = pytest.mark.timeout(30)

# Matches the probes fixture, which spawns two real worker processes per test.
# The metrics tests assert against that rather than fight it.
NUM_WORKERS = 2


def worker_by_id(body: dict, worker_id: int) -> dict:
    """
    Finds a worker entry by id

    Args:
        body        - Parsed /metrics/status response
        worker_id   - Worker id to look up
    """
    return next(w for w in body["workers"] if w["workerId"] == worker_id)


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
    Create mock config object with the metrics endpoint enabled
    """
    mock = MagicMock(spec=Config)

    mock.api_key = API_KEY
    mock.metrics_api_key = METRICS_API_KEY
    # Telemetry publishing off: a MagicMock's `redis_url` is otherwise a truthy
    # mock, which sends the lifespan into opening a Redis connection to a
    # nonsense URL and hangs startup.
    mock.redis_url = ""
    # Real numbers, not a MagicMock: create_webserver feeds these straight
    # into CapacityEstimator's ratchet, which does arithmetic on them the
    # moment a worker leaves warm-up.
    mock.target_busy = 0.85
    mock.min_sessions = 1
    mock.max_sessions = None
    mock.ws_init_timeout_sec = TIMEOUT_SEC
    mock.provider_config.num_workers = NUM_WORKERS
    mock.provider_config.contexts = []
    mock.provider_config.providers = {
        "debug": TranscriptionProviderConfigSchema(
            provider_uid=TranscriptionProviderUID.DEBUG, provider_config=None
        )
    }
    return mock


@pytest_asyncio.fixture
async def test_client(mock_config: Config, mock_logger: Logger):
    """
    Create fresh FastAPI test client for each test
    """
    with TestClient(create_webserver(mock_config, mock_logger)) as client:
        yield client


@pytest_asyncio.fixture
async def disabled_test_client(mock_config: Config, mock_logger: Logger):
    """
    Create a test client for a deployment with no metrics key configured
    """
    mock_config.metrics_api_key = ""
    with TestClient(create_webserver(mock_config, mock_logger)) as client:
        yield client


def test_rejects_request_with_no_credential(test_client: TestClient):
    """
    Test an unauthenticated read is refused
    """
    # Act
    response = test_client.get("/metrics/status")

    # Assert
    assert response.status_code == 401
    assert response.json()["code"] == "INVALID_METRICS_KEY"


def test_rejects_wrong_key(test_client: TestClient):
    """
    Test a wrong key gets the same 401 as a missing one

    A prober should not be able to tell the two apart.
    """
    # Act
    response = test_client.get(
        "/metrics/status", headers={"authorization": "Bearer wrong-key"}
    )

    # Assert
    assert response.status_code == 401
    assert response.json()["code"] == "INVALID_METRICS_KEY"


def test_rejects_the_session_api_key(test_client: TestClient):
    """
    Test the key that opens transcription sessions cannot read metrics
    """
    # Act
    response = test_client.get(
        "/metrics/status", headers={"authorization": f"Bearer {API_KEY}"}
    )

    # Assert
    assert response.status_code == 401


def test_unconfigured_key_leaves_the_route_unregistered(
    disabled_test_client: TestClient,
):
    """
    Test a deployment without a metrics key 404s rather than 401s

    A switched-off endpoint should not look like a misconfigured credential.
    """
    # Act
    response = disabled_test_client.get(
        "/metrics/status", headers={"authorization": f"Bearer {API_KEY}"}
    )

    # Assert
    assert response.status_code == 404


def test_reports_workers_and_capacity(test_client: TestClient):
    """
    Test an authenticated read reports pool capacity and one entry per worker

    numWorkers is the deployed value the capacity model has been carrying as
    an open question; the endpoint reporting it is how it stops being one.
    """
    # Act
    response = test_client.get(
        "/metrics/status",
        headers={"authorization": f"Bearer {METRICS_API_KEY}"},
    )

    # Assert
    assert response.status_code == 200
    body = response.json()

    assert body["numWorkers"] == NUM_WORKERS
    assert body["providerKeys"] == ["debug"]
    # The period the debug provider really registers its jobs with. Reported so
    # the monitoring sidecar stops being told the same number in its own
    # environment: this one is a literal in debug_provider.py rather than a
    # provider_config field, which is why the value is asked of the provider
    # instead of read off its config.
    assert body["providerJobPeriodMs"] == {"debug": DEBUG_JOB_PERIOD_MS}
    assert len(body["workers"]) == NUM_WORKERS
    assert [worker["workerId"] for worker in body["workers"]] == [0, 1]
    for worker in body["workers"]:
        # NOT asserted to be 0. The rolling window opens when the worker
        # process starts, and its first state change is the busy stretch of
        # startup, so a just-booted idle worker legitimately reads 1.0 until
        # enough idle time accumulates to dilute it. Any alert rule built on
        # this must tolerate a restart spike.
        assert 0 <= worker["utilization"] <= 1
        assert worker["liveJobCount"] == 0
        assert worker["totalJobsRegistered"] == 0
        assert worker["contextIds"] == []
        assert worker["activeJobs"] == []
        # The capacity estimator's warm-up default (PLAN-AdmissionControl.md
        # §3): nothing has called record() yet in a freshly-started test
        # client, so every worker reads "not measured", never a fabricated
        # zero.
        assert worker["estimatedCapacitySessions"] is None


def test_reports_identity_and_empty_series_before_any_job(
    test_client: TestClient,
):
    """
    Test the restart-detection fields are present and series start empty

    An idle process must report zero series rather than omit the blocks, so a
    consumer's parse does not depend on whether traffic has happened yet.
    """
    # Act
    response = test_client.get(
        "/metrics/status",
        headers={"authorization": f"Bearer {METRICS_API_KEY}"},
    )

    # Assert
    body = response.json()
    assert body["processUid"]
    assert body["processStartedAt"].endswith("+00:00")
    assert body["counters"]["jobsCompletedTotal"] == []
    assert body["counters"]["jobsFailedTotal"] == []
    assert body["histograms"]["asrExecutionMs"] == []
    assert body["histograms"]["asrRtf"] == []
    assert body["counters"]["bufferOverflowTotal"] == []
    assert body["counters"]["audioDroppedBufferFullTotal"] == []
    assert body["counters"]["audioDroppedBufferFullSecondsTotal"] == []
    assert body["counters"]["vadNoSpeechTotal"] == []
    assert body["counters"]["noWordsTotal"] == []
    assert body["counters"]["asrAudioSecondsTotal"] == []
    assert body["counters"]["compressionRatioGuardFiredTotal"] == []
    assert body["counters"]["avgLogprobGuardFiredTotal"] == []
    assert body["counters"]["noSpeechProbGuardFiredTotal"] == []
    assert body["counters"]["temperatureFallbackTotal"] == []
    assert body["counters"]["repeatedSegmentDetectedTotal"] == []
    assert body["counters"]["asrDroppedPeriodsTotal"] == []
    # An idle process has refused nobody, and an operator asking "is anyone
    # being turned away" needs to be able to read "no" rather than silence.
    assert body["counters"]["sessionsRefusedCapacityTotal"] == []


@pytest.mark.asyncio
async def test_records_a_real_job_execution(test_client: TestClient):
    """
    Test job statistics from a live session reach the endpoint

    This is the gate that proves the whole chain: the debug provider's job runs
    in a spawned worker process, its result crosses the result queue, the
    worker pool hook folds it into the registry, and the endpoint reports it -
    labelled with the provider key the session was opened against.
    """
    # Arrange
    headers = {"authorization": f"Bearer {METRICS_API_KEY}"}
    labels = {"provider_key": "debug"}

    # Act
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
        # The debug job's period is 1000ms, so one full period plus slack
        await asyncio.sleep(1.5)

        live = test_client.get("/metrics/status", headers=headers).json()

    body = test_client.get("/metrics/status", headers=headers).json()

    # Assert
    # The pool routes to the least utilized worker, so which one ran the job is
    # not fixed; exactly one must have held it.
    assert sum(w["liveJobCount"] for w in live["workers"]) == 1
    assert sum(w["totalJobsRegistered"] for w in live["workers"]) == 1
    ran_on = next(w["workerId"] for w in live["workers"] if w["liveJobCount"])

    completed = body["counters"]["jobsCompletedTotal"]
    assert len(completed) == 1
    assert completed[0]["labels"] == labels
    assert completed[0]["value"] >= 1

    execution = body["histograms"]["asrExecutionMs"]
    assert len(execution) == 1
    assert execution[0]["labels"] == labels
    assert execution[0]["count"] >= 1
    assert execution[0]["p95"] >= 0

    # The session ended with the websocket, so the job is gone - but the
    # registration total is monotonic and must not fall with it.
    assert worker_by_id(body, ran_on)["liveJobCount"] == 0
    assert worker_by_id(body, ran_on)["totalJobsRegistered"] == 1


def test_process_uid_is_stable_across_polls(test_client: TestClient):
    """
    Test the uid does not change between reads of the same process

    Consumers difference absolute counters and rebase on a uid change, so a
    uid that churned would discard every delta.
    """
    # Arrange
    headers = {"authorization": f"Bearer {METRICS_API_KEY}"}

    # Act
    first = test_client.get("/metrics/status", headers=headers).json()
    second = test_client.get("/metrics/status", headers=headers).json()

    # Assert
    assert first["processUid"] == second["processUid"]
    assert first["processStartedAt"] == second["processStartedAt"]
