"""
Integration tests for the /providers/health endpoint
"""

import logging
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
METRICS_API_KEY = "TEST_METRICS_KEY"
TIMEOUT_SEC = 1

# Real worker processes are spawned per test, which is well past the global 1s
# pytest timeout.
pytestmark = pytest.mark.timeout(30)

NUM_WORKERS = 2

# A whisper provider pointed at context tags that no context defines. The pool
# is healthy, readiness returns 200, and this provider can still never route -
# the exact blind spot B1.7 exists to close.
UNROUTABLE_WHISPER_CONFIG = {
    "whisper_context_tag": "no_such_whisper_context",
    "silero_context_tag": "no_such_silero_context",
    "job_period_ms": 1000,
    "max_buffer_len_sec": 20.0,
    "local_agree_dim": 2,
}


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
    Create mock config object with the metrics key configured
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
        ),
        "whisper": TranscriptionProviderConfigSchema(
            provider_uid=TranscriptionProviderUID.WHISPER_STREAMING,
            provider_config=UNROUTABLE_WHISPER_CONFIG,
        ),
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


def _health(client: TestClient):
    """
    Reads the provider health body with a valid credential

    Args:
        client  - Test client to read through
    """
    response = client.get(
        "/providers/health",
        headers={"authorization": f"Bearer {METRICS_API_KEY}"},
    )
    assert response.status_code == 200
    return response.json()


def test_rejects_request_with_no_credential(test_client: TestClient):
    """
    Test an unauthenticated read is refused

    Unlike /probes/*, this body names providers, upstream endpoints and worker
    layout, so it is internal detail rather than a load balancer's business.
    """
    # Act
    response = test_client.get("/providers/health")

    # Assert
    assert response.status_code == 401
    assert response.json()["code"] == "INVALID_METRICS_KEY"


def test_rejects_wrong_key(test_client: TestClient):
    """
    Test a wrong key gets the same 401 as a missing one
    """
    # Act
    response = test_client.get(
        "/providers/health", headers={"authorization": "Bearer wrong-key"}
    )

    # Assert
    assert response.status_code == 401
    assert response.json()["code"] == "INVALID_METRICS_KEY"


def test_rejects_the_transcription_api_key(test_client: TestClient):
    """
    Test the session-opening key does not grant telemetry reads

    The two keys grant very different things - this one only reads telemetry,
    the API key opens ASR sessions and streams audio - and the consumers here
    are the least privileged components in the deployment.
    """
    # Act
    response = test_client.get(
        "/providers/health", headers={"authorization": f"Bearer {API_KEY}"}
    )

    # Assert
    assert response.status_code == 401


def test_route_is_absent_when_no_metrics_key_configured(
    disabled_test_client: TestClient,
):
    """
    Test an unconfigured deployment answers 404 rather than 401

    A switched-off endpoint should not look like a misconfigured credential;
    the sidecar's poller already treats 404 as "off at the far end".
    """
    # Act
    response = disabled_test_client.get(
        "/providers/health",
        headers={"authorization": f"Bearer {METRICS_API_KEY}"},
    )

    # Assert
    assert response.status_code == 404


def test_reports_the_same_process_identity_as_metrics_status(
    test_client: TestClient,
):
    """
    Test both telemetry endpoints report one identity for the process

    `invalidProviderKeyRejects` here and the counters on /metrics/status are
    all monotonic since process start, so a consumer differencing either reads
    a restart as a large negative rate unless it can see the process changed.
    That only works across the two endpoints if the uid is genuinely the same
    one - a per-endpoint uid would look right and correlate wrong.
    """
    # Act
    providers = _health(test_client)
    metrics = test_client.get(
        "/metrics/status",
        headers={"authorization": f"Bearer {METRICS_API_KEY}"},
    ).json()

    # Assert
    assert providers["processUid"] == metrics["processUid"]
    assert providers["processStartedAt"] == metrics["processStartedAt"]


def test_process_identity_is_stable_across_polls(test_client: TestClient):
    """
    Test the identity does not change between reads of a single process

    A uid minted per request would silently defeat the restart detection it
    exists to enable, while still looking present in the body.
    """
    # Act
    uids = {_health(test_client)["processUid"] for _ in range(3)}

    # Assert
    assert len(uids) == 1


def test_reports_pool_wide_context(test_client: TestClient):
    """
    Test the body carries the worker layout alongside the providers
    """
    # Act
    body = _health(test_client)

    # Assert
    assert body["numWorkers"] == NUM_WORKERS
    assert len(body["workers"]) == NUM_WORKERS
    assert all(worker["alive"] for worker in body["workers"])
    assert {worker["workerId"] for worker in body["workers"]} == {0, 1}


def test_reports_every_configured_provider(test_client: TestClient):
    """
    Test each configured key appears with the implementation behind it
    """
    # Act
    body = _health(test_client)

    # Assert
    assert set(body["providers"]) == {"debug", "whisper"}
    assert body["providers"]["debug"]["providerUid"] == "debug"
    assert body["providers"]["whisper"]["providerUid"] == "whisper-streaming"


def test_reports_a_provider_whose_contexts_no_worker_owns_as_down(
    test_client: TestClient,
):
    """
    Test the mis-set tags failure is reported, while readiness stays 200

    This is the gap B1.7 closes: the pool is entirely healthy, so readiness
    cannot see that every session routed to this provider is doomed.
    """
    # Act
    body = _health(test_client)
    readiness = test_client.get("/probes/readiness")

    # Assert
    whisper = body["providers"]["whisper"]
    assert whisper["kind"] == "local"
    assert whisper["status"] == "down"
    assert whisper["modelLoaded"] is False
    assert whisper["owningWorkers"] == []
    assert "no_such_whisper_context" in whisper["detail"]

    # The blind spot itself: readiness is perfectly happy.
    assert readiness.status_code == 200


def test_reports_a_context_free_provider_as_ok(test_client: TestClient):
    """
    Test the debug provider is a working control, needing no context
    """
    # Act
    body = _health(test_client)

    # Assert
    debug = body["providers"]["debug"]
    assert debug["kind"] == "debug"
    assert debug["status"] == "ok"
    assert debug["activeSessions"] == 0


def test_reports_active_job_correlated_to_session_and_room_uid(
    test_client: TestClient,
):
    """
    Test a live session's session_uid/room_uid surface as an ActiveJob on the
    worker holding its job - the correlation an operator needs to trace a
    saturated worker back to the session/room causing it (B1.7 follow-up,
    part 2 of 2)
    """
    # Act
    with test_client.websocket_connect(
        "/transcription_stream/debug"
    ) as websocket:
        websocket.send_json({"type": "auth", "api_key": API_KEY})
        websocket.send_json(
            {
                "type": "config",
                "config": {"sample_rate": 16000, "num_channels": 1},
                "session_uid": "session-1",
                "room_uid": "room-1",
            }
        )
        # start_session() emits synchronously within config handling, so
        # receiving it proves the session (and its job registration) exists
        # server-side before the health read below.
        websocket.receive_json()

        body = _health(test_client)

    # Assert
    active_jobs = [
        job for worker in body["workers"] for job in worker["activeJobs"]
    ]
    assert len(active_jobs) == 1
    assert active_jobs[0]["sessionUid"] == "session-1"
    assert active_jobs[0]["roomUid"] == "room-1"


def test_counts_invalid_provider_key_rejects(test_client: TestClient):
    """
    Test a stream opened against an unknown provider key is counted

    A typo in the free-text `transcriptionProviderId` closes the socket with a
    bare 1007 that looks like a broken service; this counter names the cause.
    """
    # Arrange
    assert _health(test_client)["invalidProviderKeyRejects"] == 0

    # Act
    with test_client.websocket_connect(
        "/transcription_stream/NOT_A_REAL_PROVIDER"
    ) as websocket:
        websocket.send_json({"type": "auth", "api_key": API_KEY})
        websocket.send_json({"type": "config", "config": {}})

        # The bare 1007 the client sees, with nothing naming the cause. That
        # is the whole reason the counter below exists.
        with pytest.raises(WebSocketDisconnect):
            websocket.receive_text()

    # Assert
    assert _health(test_client)["invalidProviderKeyRejects"] == 1


def test_repeated_polls_are_stable(test_client: TestClient):
    """
    Test polling in a loop neither errors nor mutates what it reports

    The dashboard polls this continuously and every operator browser
    multiplies that rate, so reads must stay pure.
    """
    # Act
    bodies = [_health(test_client) for _ in range(5)]

    # Assert
    for body in bodies:
        assert body["providers"]["whisper"]["status"] == "down"
        assert body["invalidProviderKeyRejects"] == 0
        assert body["numWorkers"] == NUM_WORKERS
