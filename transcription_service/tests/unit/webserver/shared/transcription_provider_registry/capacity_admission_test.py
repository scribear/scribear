"""
Unit tests for capacity admission in TranscriptionProviderRegistry
(PLAN-AdmissionControl.md §4/§6)

These cover the half of admission control that decides and refuses. The
estimator that supplies N* has its own suite
(`tests/unit/shared/utils/worker_pool/capacity_estimator_test.py`) and is used
here as a real collaborator rather than a mock, pinned with `max_sessions` so
each test states the ceiling it is exercising instead of having to first drive
the estimator through a measurement.

The scenario behind all of it: a lecture room asks for captions on a
transcription host whose one worker is already carrying as many sessions as it
can transcribe in realtime. Before this, the seventh room was accepted, every
room degraded together, and nothing said no. The cost of getting this wrong in
the other direction is a real user with no captions and no way to tell why -
which is why every gate here fails open, and why several of these tests pin
the *admitting* path rather than the refusing one.

WHAT MOVED. Admission used to be decided synchronously inside
`create_session`, because a session's job registered as part of its own
construction. Registration is now deferred to a session's own first
`handle_audio_chunk` (an idle, audio-less connection must never take a worker's
job slot), so `create_session` has nothing to decide any more - see
`transcription_provider_registry_test.py` for its (unchanged) provider-loading
and provider-key behaviour. What the registry still owns is the *decision
itself*: a callable built by `_make_admission_check` and bound onto each
provider at load time via `bind_admission_check`, which a session calls once
it has registered and knows which worker (if any) it landed on. These tests
exercise that callable directly, extracted from the mock provider's
`bind_admission_check` call - `whisper_streaming_session_test.py` covers a real
session actually calling it and undoing its own registration on a refusal.
"""

from unittest.mock import MagicMock

import pytest
from pytest_mock import MockerFixture, MockType

from src.shared.config import (
    Config,
    JobContextConfigSchema,
    JobContextDefinitionUID,
    ProviderConfigFileSchema,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
from src.shared.logger import Logger
from src.shared.utils.worker_pool import (
    CapacityEstimator,
    JobContextInterface,
    WorkerPool,
    WorkerSnapshot,
)
from src.transcription_provider_interface import (
    AT_CAPACITY_REASON,
    TranscriptionCapacityError,
    TranscriptionClientError,
    TranscriptionProviderInterface,
)
from src.webserver.shared.metrics import MetricsRegistry
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)

NUM_WORKERS = 2
PROVIDER_KEY = "asr_0"
OTHER_PROVIDER_KEY = "asr_1"

# The worker every test checks admission for. Not 0, so a test that silently
# defaulted a worker id somewhere would fail rather than pass by coincidence.
PLACED_WORKER_ID = 1


def worker_snapshot(worker_id: int, live_job_count: int) -> WorkerSnapshot:
    """One worker's load, as the pool reports it after registration."""
    return WorkerSnapshot(
        worker_id=worker_id,
        utilization=0.5,
        live_job_count=live_job_count,
        total_jobs_registered=live_job_count,
        context_ids=set(),
        alive=True,
        active_jobs=(),
    )


def pinned_estimator(max_sessions: int | None) -> CapacityEstimator:
    """
    A real estimator whose ceiling is an operator pin rather than a measurement

    `max_sessions` wins over warm-up inside `_capacity`, so this reports a
    definite N* from the first call without any observations having to be fed
    in. That keeps these tests about the registry's decision, which is what
    they are for; how N* is arrived at is the estimator suite's subject.
    """
    return CapacityEstimator(
        target_busy=0.85, min_sessions=1, max_sessions=max_sessions
    )


@pytest.fixture
def mock_config():
    """
    Config naming two providers over a two-worker pool
    """
    mock = MagicMock(spec=Config)

    context_configs: list[JobContextConfigSchema] = [
        JobContextConfigSchema(
            context_uid=JobContextDefinitionUID.FASTER_WHISPER,
            worker_ids=[0, 1],
            tags=["whisper"],
            context_config="config:faster_0",
        )
    ]

    provider_configs: dict[str, TranscriptionProviderConfigSchema] = {
        PROVIDER_KEY: TranscriptionProviderConfigSchema(
            provider_uid=TranscriptionProviderUID.DEBUG,
            provider_config="config:asr_0",
        ),
        OTHER_PROVIDER_KEY: TranscriptionProviderConfigSchema(
            provider_uid=TranscriptionProviderUID.DEBUG,
            provider_config="config:asr_1",
        ),
    }

    mock.provider_config = ProviderConfigFileSchema(
        num_workers=NUM_WORKERS,
        contexts=context_configs,
        providers=provider_configs,
    )
    return mock


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for tests
    """
    mock = MagicMock(spec=Logger)
    mock.child.return_value = mock
    return mock


@pytest.fixture
def mock_context_import(mocker: MockerFixture):
    """
    Patches the job-context import so no model is loaded
    """
    mock = mocker.MagicMock()
    mock.FasterWhisperContext = mocker.MagicMock(
        return_value=mocker.MagicMock(spec=JobContextInterface)
    )
    mocker.patch.dict(
        "sys.modules",
        {"src.transcription_contexts.faster_whisper_context": mock},
    )
    return mock


@pytest.fixture
def mock_worker_pool_instance(mocker: MockerFixture):
    """
    Mock instance for worker pool
    """
    return mocker.MagicMock(spec=WorkerPool)


@pytest.fixture
def mock_worker_pool_import(
    mocker: MockerFixture, mock_worker_pool_instance: MagicMock
):
    """
    Mock worker pool
    """
    return mocker.patch(
        "src.webserver.shared.transcription_provider_registry"
        ".transcription_provider_registry.WorkerPool",
        return_value=mock_worker_pool_instance,
    )


@pytest.fixture
def mock_provider_instances(mocker: MockerFixture):
    """
    Mock provider instances for the two configured providers
    """
    return [
        mocker.MagicMock(spec=TranscriptionProviderInterface),
        mocker.MagicMock(spec=TranscriptionProviderInterface),
    ]


@pytest.fixture
def mock_provider_import(
    mocker: MockerFixture, mock_provider_instances: list[MagicMock]
) -> MockType:
    """
    Patches provider imports so the registry loads the mocks above
    """
    mock_debug_module = mocker.MagicMock()
    mock_debug_module.DebugProvider = mocker.MagicMock(
        side_effect=[mock_provider_instances[0], mock_provider_instances[1]]
    )
    mocker.patch.dict(
        "sys.modules",
        {"src.transcription_providers.debug_provider": mock_debug_module},
    )
    return mock_debug_module.DebugProvider


@pytest.fixture
def metrics_registry():
    """
    A real telemetry store, so the counter assertions read the shape
    /metrics/status will actually publish
    """
    return MetricsRegistry()


# pylint: disable=unused-argument
def make_registry(
    config: Config,
    logger: Logger,
    estimator: CapacityEstimator | None,
    metrics: MetricsRegistry | None,
) -> TranscriptionProviderRegistry:
    """Registry over the patched imports, wired to the given collaborators."""
    return TranscriptionProviderRegistry(
        config, logger, None, estimator, metrics
    )


# pylint: disable=unused-argument
@pytest.fixture
def registry(
    mock_config: Config,
    mock_logger: Logger,
    mock_worker_pool_import: MagicMock,
    mock_context_import: MockType,
    mock_provider_import: MockType,
    metrics_registry: MetricsRegistry,
):
    """
    Registry pinned to one session per worker

    One is the ceiling this branch's own live CPU sweep measured on the shipped
    default config (LESSONSLEARNED-AdmissionControl.md), so it is the realistic
    setting to build the refusal tests on rather than an arbitrarily tiny one.
    """
    return make_registry(
        mock_config, mock_logger, pinned_estimator(1), metrics_registry
    )


def admission_check(provider_instance: MagicMock, provider_index: int = 0):
    """
    Gets the admission callable the registry bound onto a mock provider

    Args:
        provider_instance   - The mock provider whose binding to read
        provider_index       - Unused, kept for call-site symmetry with the
                                two-provider fixtures

    A session calls this itself once it has registered a job and knows which
    worker (if any) it landed on - see `check_admission` on
    TranscriptionProviderInterface. Extracting it here is what lets these
    tests exercise the registry's actual decision without standing up a real
    session.
    """
    del provider_index
    (check,), _ = provider_instance.bind_admission_check.call_args
    return check


def test_admission_check_raises_when_the_worker_is_already_full(
    registry: TranscriptionProviderRegistry,
    mock_worker_pool_instance: MagicMock,
    mock_provider_instances: list[MagicMock],
):
    """
    Test a session whose worker is already full is refused with the capacity
    error

    The measured case: worker 1 is already carrying its one session, a second
    room's session registers a job and lands there too (routing balances load,
    it does not enforce a ceiling). `live_job_count` is 2 because the new
    session has already registered by the time the check runs - that is the
    whole point of the register-then-ask order, since the worker is only
    chosen inside `register_job`.

    The type matters as much as the refusal. `TranscriptionCapacityError` is
    not a `TranscriptionClientError`, because that one closes 1007 and blames
    the client for the service being busy - the exact misattribution PR #171
    removed.
    """
    # Arrange
    mock_worker_pool_instance.worker_snapshots.return_value = [
        worker_snapshot(PLACED_WORKER_ID, live_job_count=2)
    ]
    check = admission_check(mock_provider_instances[0])

    # Act / Assert
    with pytest.raises(TranscriptionCapacityError) as refusal:
        check(PLACED_WORKER_ID, MagicMock(spec=Logger))

    assert refusal.value.message == AT_CAPACITY_REASON
    assert not isinstance(refusal.value, TranscriptionClientError)


def test_refusal_increments_the_counter_under_its_provider_key(
    registry: TranscriptionProviderRegistry,
    mock_worker_pool_instance: MagicMock,
    metrics_registry: MetricsRegistry,
    mock_provider_instances: list[MagicMock],
):
    """
    Test each refusal is counted against the provider it was refused for

    Without this a refusal is indistinguishable from a client that hung up:
    both end as a closed socket with no transcript, and only one of them means
    the deployment needs more capacity. Labelled by provider key because a host
    serving both a local model and a remote one needs to know which of the two
    it has run out of - proven here by refusing on the first provider's
    callback and confirming the second provider's counter is untouched.
    """
    # Arrange
    mock_worker_pool_instance.worker_snapshots.return_value = [
        worker_snapshot(PLACED_WORKER_ID, live_job_count=2)
    ]
    check = admission_check(mock_provider_instances[0])

    # Act
    for _ in range(3):
        with pytest.raises(TranscriptionCapacityError):
            check(PLACED_WORKER_ID, MagicMock(spec=Logger))

    # Assert
    counter = metrics_registry.sessions_refused_capacity_total
    assert counter.get({"provider_key": PROVIDER_KEY}) == 3
    assert counter.get({"provider_key": OTHER_PROVIDER_KEY}) == 0


def test_admitted_worker_is_not_counted_as_a_refusal(
    registry: TranscriptionProviderRegistry,
    mock_worker_pool_instance: MagicMock,
    metrics_registry: MetricsRegistry,
    mock_provider_instances: list[MagicMock],
):
    """
    Test a worker under the ceiling admits and counts nothing

    The regression this guards is the one nobody would notice in a test that
    only exercised refusals: every session in every healthy deployment takes
    this path, so "no observable difference" is the property that matters
    most.

    `live_job_count` is 1 - this session and nothing else - which is the
    off-by-one `_admits_worker`'s `- 1` exists for. `admit()` is specified over
    N *before* placement, so the count has to have the new session subtracted
    back out; passing it raw would ask whether a second session fits on a
    pinned-to-one worker and refuse the first client to ever connect.
    """
    # Arrange
    mock_worker_pool_instance.worker_snapshots.return_value = [
        worker_snapshot(PLACED_WORKER_ID, live_job_count=1)
    ]
    check = admission_check(mock_provider_instances[0])

    # Act / Assert - does not raise
    check(PLACED_WORKER_ID, MagicMock(spec=Logger))
    assert metrics_registry.sessions_refused_capacity_total.entries() == []


def test_worker_id_none_is_never_checked(
    mock_config: Config,
    mock_logger: Logger,
    mock_worker_pool_instance: MagicMock,
    mock_provider_instances: list[MagicMock],
    metrics_registry: MetricsRegistry,
    mocker: MockerFixture,
    mock_worker_pool_import: MagicMock,
    mock_context_import: MockType,
    mock_provider_import: MockType,
):
    """
    Test worker_id=None is never even asked about the estimator

    This is how `lumen_granite` and `debug` are excluded (§5/§7 defer remote
    providers: their capacity question is upstream rate limits and latency, not
    a local worker pool), and it is also the state before a session has
    registered a job at all. Both register jobs with an empty context tag
    tuple, so the worker they land on is whichever was least utilized rather
    than a placement onto the model that would serve them -
    `admission_worker_id` returning None is that statement, and the base
    TranscriptionSessionInterface returns None so a provider is excluded until
    it deliberately opts in.

    The estimator is pinned at zero, so it would refuse anything it was asked
    about. Asserting `admit` was never *called* rather than just that the
    check returned normally proves the exclusion happens before the decision,
    not that the decision happened to come out permissive.
    """
    # Arrange
    estimator = pinned_estimator(0)
    admit = mocker.spy(estimator, "admit")
    registry = make_registry(
        mock_config, mock_logger, estimator, metrics_registry
    )
    del registry  # only constructed to drive _load_providers' binding
    mock_worker_pool_instance.worker_snapshots.return_value = [
        worker_snapshot(PLACED_WORKER_ID, live_job_count=99)
    ]
    check = admission_check(mock_provider_instances[0])

    # Act / Assert - does not raise
    check(None, MagicMock(spec=Logger))
    admit.assert_not_called()
    assert metrics_registry.sessions_refused_capacity_total.entries() == []


def test_admits_when_no_estimator_is_wired_up(
    mock_config: Config,
    mock_logger: Logger,
    mock_worker_pool_instance: MagicMock,
    mock_provider_instances: list[MagicMock],
    mock_worker_pool_import: MagicMock,
    mock_context_import: MockType,
    mock_provider_import: MockType,
):
    """
    Test a registry constructed without an estimator admits everything

    Keeps this class usable - and every test of it that predates admission
    control passing - without the capacity stack having to be stood up, and
    makes the default the permissive one. A registry that refused because
    nobody told it the ceiling would be the worst possible failure mode: silent
    and total.
    """
    # Arrange
    registry = make_registry(mock_config, mock_logger, None, None)
    del registry  # only constructed to drive _load_providers' binding
    mock_worker_pool_instance.worker_snapshots.return_value = [
        worker_snapshot(PLACED_WORKER_ID, live_job_count=50)
    ]
    check = admission_check(mock_provider_instances[0])

    # Act / Assert - does not raise
    check(PLACED_WORKER_ID, MagicMock(spec=Logger))


def test_admits_when_the_pool_reports_no_such_worker(
    registry: TranscriptionProviderRegistry,
    mock_worker_pool_instance: MagicMock,
    metrics_registry: MetricsRegistry,
    mock_provider_instances: list[MagicMock],
):
    """
    Test a worker missing from the pool snapshot is admitted

    Reachable if a worker dies between registration and this read. That is a
    pool fault, and refusing the user for it would report a crashed worker to
    them as "we are busy, try later" - a misattribution of exactly the kind
    this error type exists to avoid. The session will fail its way, loudly, on
    the path that owns that failure.
    """
    # Arrange - snapshots for a different worker than the session landed on
    mock_worker_pool_instance.worker_snapshots.return_value = [
        worker_snapshot(PLACED_WORKER_ID + 1, live_job_count=99)
    ]
    check = admission_check(mock_provider_instances[0])

    # Act / Assert - does not raise
    check(PLACED_WORKER_ID, MagicMock(spec=Logger))
    assert metrics_registry.sessions_refused_capacity_total.entries() == []


def test_create_session_never_raises_capacity_error(
    registry: TranscriptionProviderRegistry,
    mock_worker_pool_instance: MagicMock,
    mock_provider_instances: list[MagicMock],
):
    """
    Test create_session returns normally even when the worker it would use is
    already full

    The contract that changed: a session's job (and therefore its worker
    placement) no longer registers as part of construction, so there is
    nothing for `create_session` to ask about any more - see the module
    docstring. Refusal now happens later, from the session's own first
    `handle_audio_chunk`, which this mocked session never calls, so nothing
    here can be refused - proving that the burden of asking has genuinely
    moved off `create_session`, not just that this particular mock stayed
    quiet.
    """
    # Arrange
    mock_worker_pool_instance.worker_snapshots.return_value = [
        worker_snapshot(PLACED_WORKER_ID, live_job_count=99)
    ]
    session_logger = MagicMock(spec=Logger)

    # Act
    session = registry.create_session(
        PROVIDER_KEY, "config", "session-1", "room-1", session_logger
    )

    # Assert
    assert session is mock_provider_instances[0].create_session.return_value
    mock_provider_instances[0].create_session.assert_called_once_with(
        "config", "session-1", "room-1", session_logger
    )


def test_unknown_provider_key_still_raises_the_client_error(
    registry: TranscriptionProviderRegistry, metrics_registry: MetricsRegistry
):
    """
    Test a typo'd provider key is still a 1007 client error, not a 1013

    Unlike capacity, this refusal is still decided synchronously inside
    `create_session` - a provider key either names a configured provider or it
    does not, which is knowable immediately and has nothing to do with worker
    load. A client that retried this forever would never succeed; retrying a
    capacity refusal is correct.
    """
    # Act / Assert
    with pytest.raises(TranscriptionClientError) as error:
        registry.create_session(
            "NOT_A_REAL_PROVIDER", "config", None, None, MagicMock(spec=Logger)
        )

    assert not isinstance(error.value, TranscriptionCapacityError)
    assert metrics_registry.sessions_refused_capacity_total.entries() == []
