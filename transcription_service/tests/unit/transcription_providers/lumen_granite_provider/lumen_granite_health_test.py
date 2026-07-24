"""
Unit tests for LumenGraniteProvider health reporting
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from pytest_mock import MockerFixture

from src.shared.logger import Logger
from src.shared.utils.worker_pool import WorkerPool
from src.transcription_provider_interface import ProviderKind, ProviderStatus
from src.transcription_providers.lumen_granite_provider import (
    LumenGraniteProvider,
)

API_KEY_ENV = "TEST_LUMEN_API_KEY"
BASE_URL = "https://lumen.example.invalid/v1"
PROVIDER_KEY = "lumen_granite"
# The provider fixture below never overrides `model`, so this is the config
# default (see LumenGraniteProviderConfig) - the id the /models fixture body
# must list for a probe to report the model as found.
MODEL = "granite-speech-4.1-2b-plus"


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for tests
    """
    return MagicMock(spec=Logger)


@pytest.fixture
def mock_worker_pool():
    """
    Create a mocked worker pool; remote providers never route to it
    """
    return MagicMock(spec=WorkerPool)


@pytest.fixture
def provider(mock_logger: Logger, mock_worker_pool: WorkerPool):
    """
    Create a LumenGraniteProvider pointed at an unroutable test endpoint
    """
    return LumenGraniteProvider(
        {"base_url": BASE_URL, "api_key_env": API_KEY_ENV},
        mock_logger,
        mock_worker_pool,
        PROVIDER_KEY,
    )


@pytest.fixture
def mock_client_class(mocker: MockerFixture):
    """
    Patch httpx.AsyncClient so tests can assert whether the network was used
    """
    return mocker.patch(
        "src.transcription_providers.lumen_granite_provider"
        ".lumen_granite_provider.httpx.AsyncClient"
    )


def _respond_with(
    mock_client_class: MagicMock, status_code: int, json_body: object = None
):
    """
    Drives the patched client to answer every GET with the given status

    Args:
        mock_client_class   - Patched httpx.AsyncClient
        status_code         - Status the probe request should see
        json_body           - Body `.json()` returns; defaults to an OpenAI-
                               style listing that contains MODEL, so tests
                               that don't care about model listing still see
                               it as found
    """
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = (
        json_body if json_body is not None else {"data": [{"id": MODEL}]}
    )
    client = mock_client_class.return_value.__aenter__.return_value
    client.get = AsyncMock(return_value=response)
    return client


@pytest.mark.asyncio
async def test_reports_down_without_network_when_key_env_unset(
    provider: LumenGraniteProvider,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test a missing api key is answered as a config error, not a network trip

    A deployment that never configured lumen would otherwise have its health
    endpoint make a doomed request to a third party on every single poll.
    """
    # Arrange
    monkeypatch.delenv(API_KEY_ENV, raising=False)

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.DOWN
    assert health.reachable is False
    assert health.probe_latency_ms is None
    assert API_KEY_ENV in (health.detail or "")
    mock_client_class.assert_not_called()


@pytest.mark.asyncio
async def test_reports_ok_when_endpoint_answers(
    provider: LumenGraniteProvider,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test a reachable, authenticated endpoint reports ok with a measured
    latency, probing the models route with the bearer token attached
    """
    # Arrange
    monkeypatch.setenv(API_KEY_ENV, "secret")
    client = _respond_with(mock_client_class, 200)

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.kind == ProviderKind.REMOTE
    assert health.status == ProviderStatus.OK
    assert health.reachable is True
    assert health.probe_latency_ms is not None
    assert health.endpoint == BASE_URL
    assert health.model_loaded is True
    assert health.detail is None
    client.get.assert_awaited_once_with(
        f"{BASE_URL}/models", headers={"Authorization": "Bearer secret"}
    )


@pytest.mark.asyncio
async def test_reports_degraded_when_model_is_missing_from_listing(
    provider: LumenGraniteProvider,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test a models listing that omits the configured model reports degraded

    The endpoint answered and the key works, so this is not DOWN - but the
    model the provider is configured to use isn't actually being served,
    which is worth an operator's attention.
    """
    # Arrange
    monkeypatch.setenv(API_KEY_ENV, "secret")
    _respond_with(
        mock_client_class, 200, json_body={"data": [{"id": "some-other-model"}]}
    )

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.DEGRADED
    assert health.reachable is True
    assert health.model_loaded is False
    assert MODEL in (health.detail or "")


@pytest.mark.asyncio
async def test_model_loaded_is_none_when_listing_has_an_unrecognized_shape(
    provider: LumenGraniteProvider,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test a /models body that isn't the expected OpenAI shape reports unknown

    A nonstandard listing is not the same claim as "model confirmed missing",
    so it must not be treated as one - and must not flip an otherwise healthy
    probe to degraded.
    """
    # Arrange
    monkeypatch.setenv(API_KEY_ENV, "secret")
    _respond_with(mock_client_class, 200, json_body={"unexpected": "shape"})

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.OK
    assert health.reachable is True
    assert health.model_loaded is None


@pytest.mark.asyncio
async def test_reports_down_when_upstream_rejects_the_key(
    provider: LumenGraniteProvider,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test a 401 reports down and names the rejected key

    The probe now sends the real bearer token, so a 401/403 is no longer
    ambiguous liveness noise - it means the configured key is wrong, and an
    operator should be pointed at the credential, not the network.
    """
    # Arrange
    monkeypatch.setenv(API_KEY_ENV, "secret")
    _respond_with(mock_client_class, 401)

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.DOWN
    assert health.reachable is False
    assert health.model_loaded is None
    assert "401" in (health.detail or "")


@pytest.mark.asyncio
async def test_reports_down_on_upstream_server_error(
    provider: LumenGraniteProvider,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test a 5xx reports down and names the status
    """
    # Arrange
    monkeypatch.setenv(API_KEY_ENV, "secret")
    _respond_with(mock_client_class, 503)

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.DOWN
    assert health.reachable is False
    assert "503" in (health.detail or "")


@pytest.mark.asyncio
async def test_reports_down_and_names_the_transport_failure(
    provider: LumenGraniteProvider,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test a connection failure reports down with the exception class in detail

    A timeout and a DNS failure need different fixes, so the class is the
    operator's only clue about which one they have.
    """
    # Arrange
    monkeypatch.setenv(API_KEY_ENV, "secret")
    import httpx  # pylint: disable=import-outside-toplevel

    client = mock_client_class.return_value.__aenter__.return_value
    client.get = AsyncMock(side_effect=httpx.ConnectTimeout("timed out"))

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.DOWN
    assert health.reachable is False
    assert "ConnectTimeout" in (health.detail or "")


@pytest.mark.asyncio
async def test_caches_the_probe_between_calls(
    provider: LumenGraniteProvider,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test repeated health reads reuse one probe result

    Every operator browser multiplies the dashboard's poll rate, so an uncached
    probe would turn the monitoring page into a load generator aimed at a third
    party.
    """
    # Arrange
    monkeypatch.setenv(API_KEY_ENV, "secret")
    _respond_with(mock_client_class, 200)

    # Act
    for _ in range(5):
        await provider.describe_health()

    # Assert
    assert mock_client_class.call_count == 1


@pytest.mark.asyncio
async def test_probe_cache_is_not_shared_between_instances(
    mock_logger: Logger,
    mock_worker_pool: WorkerPool,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test two configured lumen providers probe independently

    They can point at different endpoints, so a cache held on the class would
    report one provider's reachability as the other's.
    """
    # Arrange
    monkeypatch.setenv(API_KEY_ENV, "secret")
    _respond_with(mock_client_class, 200)
    first = LumenGraniteProvider(
        {"base_url": BASE_URL, "api_key_env": API_KEY_ENV},
        mock_logger,
        mock_worker_pool,
        "lumen_a",
    )
    second = LumenGraniteProvider(
        # Same key env, different endpoint - so the only thing that could
        # collapse these into one probe is a shared cache.
        {
            "base_url": "https://other.example.invalid/v1",
            "api_key_env": API_KEY_ENV,
        },
        mock_logger,
        mock_worker_pool,
        "lumen_b",
    )

    # Act
    await first.describe_health()
    await second.describe_health()

    # Assert
    assert mock_client_class.call_count == 2


@pytest.mark.asyncio
async def test_reports_active_session_count(
    provider: LumenGraniteProvider,
    mock_client_class: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """
    Test open sessions are counted against the provider
    """
    # Arrange
    monkeypatch.setenv(API_KEY_ENV, "secret")
    _respond_with(mock_client_class, 200)
    provider.session_started()
    provider.session_started()
    provider.session_ended()

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.active_sessions == 1
