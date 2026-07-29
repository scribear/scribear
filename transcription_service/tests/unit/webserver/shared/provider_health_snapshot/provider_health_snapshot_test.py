"""
Unit tests for ProviderHealthSnapshotService body shaping
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.shared.utils.worker_pool import (
    ActiveJob,
    CapacityEstimator,
    WorkerSnapshot,
)
from src.transcription_provider_interface import (
    ProviderHealth,
    ProviderKind,
    ProviderStatus,
)
from src.webserver.shared.metrics import MetricsRegistry
from src.webserver.shared.process_identity import ProcessIdentity
from src.webserver.shared.provider_health_snapshot import (
    ProviderHealthSnapshotService,
)
from src.webserver.shared.transcription_provider_registry import (
    ProviderHealthEntry,
    ProvidersHealthReport,
    TranscriptionProviderRegistry,
)

IDENTITY = ProcessIdentity(
    process_uid="11111111-2222-3333-4444-555555555555",
    process_started_at="2026-07-20T12:00:00+00:00",
)

WORKER = WorkerSnapshot(
    worker_id=0,
    utilization=0.98,
    live_job_count=3,
    total_jobs_registered=7,
    context_ids={1, 0},
    alive=True,
    active_jobs=(
        ActiveJob(job_id=5, session_uid="session-1", room_uid="room-1"),
        ActiveJob(job_id=6, session_uid=None, room_uid=None),
    ),
)


def _snapshots(
    report: ProvidersHealthReport,
    capacity_estimator: CapacityEstimator | None = None,
    metrics_registry: MetricsRegistry | None = None,
) -> ProviderHealthSnapshotService:
    """
    Builds a snapshot service over a registry returning the given report

    Args:
        report              - Report the mocked registry should return
        capacity_estimator  - Estimator to merge in; defaults to one that has
                                never recorded anything, so estimated capacity
                                reads as "not measured yet" (None) unless a
                                test wants otherwise
        metrics_registry     - Metrics store to read refusal counts from;
                                defaults to one that has never recorded
                                anything, so every provider's
                                sessionsRefusedCapacityTotal reads 0 unless a
                                test wants otherwise
    """
    registry = MagicMock(spec=TranscriptionProviderRegistry)
    registry.providers_health = AsyncMock(return_value=report)
    return ProviderHealthSnapshotService(
        registry,
        IDENTITY,
        capacity_estimator
        or CapacityEstimator(
            target_busy=0.85, min_sessions=1, max_sessions=None
        ),
        metrics_registry or MetricsRegistry(),
    )


def _report(*entries: ProviderHealthEntry) -> ProvidersHealthReport:
    """
    Builds a report around the given provider entries

    Args:
        entries - Provider health entries to include
    """
    return ProvidersHealthReport(
        providers=list(entries),
        workers=[WORKER],
        num_workers=1,
        invalid_provider_key_rejects=4,
    )


@pytest.mark.asyncio
async def test_serializes_envelope_as_camel_case():
    """
    Test the envelope matches the casing every other HTTP JSON API uses

    /metrics/status already reports camelCase to the same consumers; two
    telemetry endpoints on one service must not speak two spellings.
    """
    # Arrange
    snapshots = _snapshots(_report())

    # Act
    body = await snapshots.snapshot()

    # Assert
    assert body["processUid"] == IDENTITY.process_uid
    assert body["processStartedAt"] == IDENTITY.process_started_at
    assert body["numWorkers"] == 1
    assert body["invalidProviderKeyRejects"] == 4
    assert body["workers"] == [
        {
            "workerId": 0,
            "utilization": 0.98,
            "liveJobCount": 3,
            "totalJobsRegistered": 7,
            "contextIds": [0, 1],
            "alive": True,
            "activeJobs": [
                {"jobId": 5, "sessionUid": "session-1", "roomUid": "room-1"},
                {"jobId": 6, "sessionUid": None, "roomUid": None},
            ],
            # No job has been recorded against this estimator, so the worker
            # reads "not measured yet" rather than a fabricated number.
            "estimatedCapacitySessions": None,
        }
    ]


@pytest.mark.asyncio
async def test_keys_providers_by_their_configured_key_verbatim():
    """
    Test operator-chosen provider keys are never re-cased

    They are configuration, not part of this schema - the same treatment
    /metrics/status gives label keys.
    """
    # Arrange
    snapshots = _snapshots(
        _report(
            ProviderHealthEntry(
                provider_key="lumen_granite",
                provider_uid="lumen-granite",
                health=ProviderHealth(
                    kind=ProviderKind.REMOTE,
                    status=ProviderStatus.DOWN,
                    active_sessions=1,
                ),
            )
        )
    )

    # Act
    body = await snapshots.snapshot()

    # Assert
    assert list(body["providers"]) == ["lumen_granite"]
    assert body["providers"]["lumen_granite"]["providerUid"] == "lumen-granite"


@pytest.mark.asyncio
async def test_reports_a_fixed_shape_with_nulls_for_inapplicable_fields():
    """
    Test every field is present for every kind, null where it does not apply

    A fixed shape is what lets a consumer declare all fields required and so
    catch drift at parse time; with optional fields, a field this service
    stopped sending would read as a legitimately absent value.
    """
    # Arrange
    snapshots = _snapshots(
        _report(
            ProviderHealthEntry(
                provider_key="debug",
                provider_uid="debug",
                health=ProviderHealth(
                    kind=ProviderKind.DEBUG,
                    status=ProviderStatus.OK,
                    active_sessions=0,
                ),
            )
        )
    )

    # Act
    body = await snapshots.snapshot()

    # Assert
    assert body["providers"]["debug"] == {
        "providerUid": "debug",
        "kind": "debug",
        "status": "ok",
        "activeSessions": 0,
        # Never refused, same as every never-refused provider - honestly 0,
        # not a gap, since this counter has no "not measured" state.
        "sessionsRefusedCapacityTotal": 0,
        "model": None,
        "modelLoaded": None,
        "owningWorkers": [],
        "endpoint": None,
        "reachable": None,
        "probeLatencyMs": None,
        "detail": None,
    }


@pytest.mark.asyncio
async def test_reports_the_refusal_count_alongside_active_sessions():
    """
    Test a provider's refusal count is read from the metrics registry by its
    provider key and lands next to activeSessions, as a plain int

    The counter is keyed by `provider_key` in MetricsRegistry, the same key
    this service keys `providers` by - so a provider that has never been
    refused (here, "lumen_granite") reads 0, and one that has (here,
    "whisper") reads its exact count, cast to int rather than surfacing
    Counter.get()'s float so the field never serializes as `3.0`.
    """
    # Arrange
    metrics_registry = MetricsRegistry()
    metrics_registry.record_capacity_refusal("whisper")
    metrics_registry.record_capacity_refusal("whisper")
    metrics_registry.record_capacity_refusal("whisper")
    snapshots = _snapshots(
        _report(
            ProviderHealthEntry(
                provider_key="whisper",
                provider_uid="whisper-streaming",
                health=ProviderHealth(
                    kind=ProviderKind.LOCAL,
                    status=ProviderStatus.OK,
                    active_sessions=1,
                ),
            ),
            ProviderHealthEntry(
                provider_key="lumen_granite",
                provider_uid="lumen-granite",
                health=ProviderHealth(
                    kind=ProviderKind.REMOTE,
                    status=ProviderStatus.OK,
                    active_sessions=1,
                ),
            ),
        ),
        metrics_registry=metrics_registry,
    )

    # Act
    body = await snapshots.snapshot()

    # Assert
    whisper = body["providers"]["whisper"]["sessionsRefusedCapacityTotal"]
    lumen = body["providers"]["lumen_granite"]["sessionsRefusedCapacityTotal"]
    assert whisper == 3
    assert isinstance(whisper, int)
    assert lumen == 0
    assert isinstance(lumen, int)


@pytest.mark.asyncio
async def test_serializes_owning_workers_like_pool_workers():
    """
    Test owning workers use the same record shape as the pool worker list

    Both are the same thing to a consumer, and the sidecar restates these
    shapes by hand because Python shares no schema package with the Node apps.
    """
    # Arrange
    snapshots = _snapshots(
        _report(
            ProviderHealthEntry(
                provider_key="whisper",
                provider_uid="whisper-streaming",
                health=ProviderHealth(
                    kind=ProviderKind.LOCAL,
                    status=ProviderStatus.DEGRADED,
                    active_sessions=5,
                    model_loaded=True,
                    owning_workers=[WORKER],
                ),
            )
        )
    )

    # Act
    body = await snapshots.snapshot()

    # Assert
    assert body["providers"]["whisper"]["owningWorkers"] == body["workers"]
    assert body["providers"]["whisper"]["modelLoaded"] is True
    assert body["providers"]["whisper"]["activeSessions"] == 5


@pytest.mark.asyncio
async def test_merges_estimated_capacity_onto_workers_and_owning_workers():
    """
    Test N* (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md §5) lands
    on both worker lists

    Identical to how MetricsController.status() layers this onto
    /metrics/status's `workers[]` - here it must additionally reach each
    provider's `owningWorkers[]`, which /metrics/status has no equivalent of.
    A pinned `max_sessions` is used rather than feeding the estimator real job
    observations, so the estimate is deterministic without depending on the
    ratchet's warm-up behavior, which is covered elsewhere.
    """
    # Arrange
    estimator = CapacityEstimator(
        target_busy=0.85, min_sessions=1, max_sessions=5
    )
    snapshots = _snapshots(
        _report(
            ProviderHealthEntry(
                provider_key="whisper",
                provider_uid="whisper-streaming",
                health=ProviderHealth(
                    kind=ProviderKind.LOCAL,
                    status=ProviderStatus.OK,
                    active_sessions=3,
                    owning_workers=[WORKER],
                ),
            )
        ),
        estimator,
    )

    # Act
    body = await snapshots.snapshot()

    # Assert
    assert body["workers"][0]["estimatedCapacitySessions"] == 5
    owning_workers = body["providers"]["whisper"]["owningWorkers"]
    assert owning_workers[0]["estimatedCapacitySessions"] == 5


@pytest.mark.asyncio
async def test_serializes_enums_as_their_string_values():
    """
    Test kind and status cross the wire as plain strings, not enum reprs
    """
    # Arrange
    snapshots = _snapshots(
        _report(
            ProviderHealthEntry(
                provider_key="whisper",
                provider_uid="whisper-streaming",
                health=ProviderHealth(
                    kind=ProviderKind.LOCAL,
                    status=ProviderStatus.DEGRADED,
                    active_sessions=0,
                ),
            )
        )
    )

    # Act
    body = await snapshots.snapshot()

    # Assert
    provider = body["providers"]["whisper"]
    assert provider["kind"] == "local"
    assert provider["status"] == "degraded"
    assert isinstance(provider["kind"], str)


@pytest.mark.asyncio
async def test_reports_process_identity_alongside_the_reject_counter():
    """
    Test the monotonic counter is reported with the identity that scopes it

    `invalidProviderKeyRejects` never resets except by restart, so a consumer
    differencing it across polls reads a restart as a large negative rate
    unless it can see the process changed. That is what `processUid` is for,
    and it is the same uid /metrics/status reports.
    """
    # Arrange
    snapshots = _snapshots(_report())

    # Act
    body = await snapshots.snapshot()

    # Assert
    assert body["processUid"] == IDENTITY.process_uid
    assert body["invalidProviderKeyRejects"] == 4
