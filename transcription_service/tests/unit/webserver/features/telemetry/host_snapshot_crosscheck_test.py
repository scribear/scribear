"""
Cross-check leg: emits the exact bytes RedisTelemetryPublisher writes for a
fully-populated host, so the TypeScript reader's schema can be checked against
them

The live leg in `apps/node-server` already runs the shipped image's publisher
into a real Redis and parses the result with `parseTranscriptionHostSnapshot`.
It cannot reach the nested worker shape: a debug-only provider configuration
loads no model context, so `contextIds`, `owningWorkers` and `activeJobs` are
all `[]` on the wire, and an empty array satisfies any element type at all.
Restoring the historical `contextIds: Type.Array(Type.String())` bug passes
that leg -- verified, not assumed.

Populating those arrays for real needs a model, which is far too much to ask
of a schema check. Populating them honestly does not: `serialize_worker` is
the one function both `/metrics/status` and `/providers/health` serialize
workers through, and driving the real publisher over a populated report
produces exactly the bytes a loaded host would write.

So this test owns the manifest at `tools/telemetry-snapshot-crosscheck/`, and
Python is its oracle -- the file is asserted to equal what the publisher
emits, never hand-edited to match a schema. The TypeScript half reads the same
file (`infra/scribear-redis/tests/unit/transcription-host-crosscheck.test.ts`)
and is the only side that may fail because the *schema* is wrong. That
direction matters: fixtures written from the schema encode the schema's bugs,
which is precisely how the `contextIds` mismatch survived from the day it was
written.
"""

# The invariant test builds a registry through `__new__` and sets its private
# state directly, rather than through `__init__` - which spawns a worker pool.
# The alternative is a real pool for an assertion about a dict lookup.
# pylint: disable=protected-access

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.shared.logger import Logger
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
from src.webserver.features.telemetry import RedisTelemetryPublisher
from src.webserver.shared.process_identity import ProcessIdentity
from src.webserver.shared.provider_health_snapshot import (
    ProviderHealthSnapshotService,
)
from src.webserver.shared.transcription_provider_registry import (
    ProviderHealthEntry,
    ProvidersHealthReport,
    TranscriptionProviderRegistry,
)

MANIFEST_RELPATH = (
    "tools/telemetry-snapshot-crosscheck/transcription-host-snapshot.json"
)


def _manifest_path() -> Path:
    """
    Locates the manifest by walking upward from this file

    Matching `audio_meter_crosscheck_test.py`: a depth-counted `parents[n]`
    silently points at the wrong directory the moment the test moves, and the
    failure it produces names a path nobody recognises.
    """
    for candidate in [
        Path(__file__).resolve(),
        *Path(__file__).resolve().parents,
    ]:
        if (candidate / MANIFEST_RELPATH).is_file():
            return candidate / MANIFEST_RELPATH
    raise AssertionError(
        f"Could not locate {MANIFEST_RELPATH} above {__file__}"
    )


MANIFEST_PATH = _manifest_path()

HOST_ID = "crosscheck-host"

IDENTITY = ProcessIdentity(
    process_uid="11111111-2222-3333-4444-555555555555",
    process_started_at="2026-07-20T12:00:00+00:00",
)

# A `max_sessions` pin rather than a freshly-built, never-recorded-to
# estimator: the latter would put `estimatedCapacitySessions` at `null` on
# every worker, and by this file's own logic ("an empty array satisfies any
# element type at all") a null trivially satisfies
# `Type.Union([Type.Integer(), Type.Null()])` no matter what the non-null
# variant declares. Only a concrete integer on the wire exercises the
# `Type.Integer()` half of that union.
CAPACITY_ESTIMATOR = CapacityEstimator(
    target_busy=0.85, min_sessions=1, max_sessions=4
)

# Every field that a debug-only host leaves empty is non-empty here, and
# deliberately so: `context_ids` is a set of ints (the field whose element type
# was wrong in TypeScript for the schema's whole life), and `active_jobs`
# carries both the correlated and the uncorrelated case, because the schema
# declares those uids nullable rather than optional.
LOADED_WORKER = WorkerSnapshot(
    worker_id=0,
    utilization=0.98,
    live_job_count=2,
    total_jobs_registered=7,
    # `{8, 1}` rather than the obvious `{0, 1}`: CPython iterates a set of
    # small ints in slot order, which for `{0, 1}` is already sorted, so that
    # set cannot tell `sorted(...)` from `list(...)` and a publisher that
    # dropped the sort would still match the manifest. Verified by mutation -
    # with `{0, 1}` that change passes, with `{8, 1}` it fails.
    context_ids={8, 1},
    alive=True,
    active_jobs=(
        ActiveJob(job_id=5, session_uid="session-1", room_uid="room-1"),
        ActiveJob(job_id=6, session_uid=None, room_uid=None),
    ),
)

# A second worker that has died. `alive: False` is the state B1.3 exists for -
# jobs registered to it neither return nor raise - so it is worth having on the
# wire in the manifest rather than only in prose.
DEAD_WORKER = WorkerSnapshot(
    worker_id=1,
    utilization=0.0,
    live_job_count=0,
    total_jobs_registered=0,
    context_ids=set(),
    alive=False,
    active_jobs=(),
)

# One provider of each kind, so every nullable field is exercised in both its
# populated and its null state. A manifest that only carried `debug` would
# leave `model`, `modelLoaded`, `endpoint`, `reachable` and `probeLatencyMs`
# null everywhere, and `Type.Union([X, Type.Null()])` is satisfied by null
# whatever `X` is.
REPORT = ProvidersHealthReport(
    providers=[
        ProviderHealthEntry(
            provider_key="whisper",
            provider_uid="whisper-streaming",
            health=ProviderHealth(
                kind=ProviderKind.LOCAL,
                status=ProviderStatus.DEGRADED,
                active_sessions=2,
                model="small",
                model_loaded=True,
                owning_workers=[LOADED_WORKER],
                detail="all owning workers saturated",
            ),
        ),
        ProviderHealthEntry(
            provider_key="lumen_granite",
            provider_uid="lumen-granite",
            health=ProviderHealth(
                kind=ProviderKind.REMOTE,
                status=ProviderStatus.OK,
                active_sessions=1,
                model="granite-speech-4.1-2b-plus",
                endpoint="https://lumen.ncsa.illinois.edu/v1",
                reachable=True,
                probe_latency_ms=41.5,
            ),
        ),
        ProviderHealthEntry(
            provider_key="debug",
            provider_uid="debug",
            health=ProviderHealth(
                kind=ProviderKind.DEBUG,
                status=ProviderStatus.OK,
                active_sessions=0,
            ),
        ),
        # A configured provider whose own `describe_health` raised. The uid is
        # a real one, not None: see `test_a_configured_provider_always_has a
        # uid` below for why the manifest must not carry the null here even
        # though `ProviderHealthEntry.provider_uid` is typed to allow it.
        ProviderHealthEntry(
            provider_key="broken",
            provider_uid="whisper-streaming",
            health=ProviderHealth(
                kind=ProviderKind.UNKNOWN,
                status=ProviderStatus.DOWN,
                active_sessions=0,
                detail="health check failed: RuntimeError: model gone",
            ),
        ),
    ],
    workers=[LOADED_WORKER, DEAD_WORKER],
    num_workers=2,
    invalid_provider_key_rejects=4,
)


class _RecordingPipeline:
    """
    Stands in for a redis pipeline, keeping the value handed to `set`

    Only the publisher's own three calls are implemented; anything else it
    starts issuing should fail loudly here rather than be silently dropped.
    """

    def __init__(self) -> None:
        self.value: str | None = None

    def set(self, _key: str, value: str, **_kwargs: Any) -> None:
        """Records the serialized snapshot the publisher wrote"""
        self.value = value

    def zadd(self, _key: str, _mapping: dict[str, int]) -> None:
        """Ignored - the index carries no payload to cross-check"""

    def zremrangebyscore(self, _key: str, _min: int, _max: int) -> None:
        """Ignored - pruning carries no payload to cross-check"""

    async def execute(self) -> None:
        """No-op; nothing here talks to a server"""


@pytest.fixture(name="published")
def published_fixture() -> dict[str, Any]:
    """
    Drives the real publisher over the populated report and returns what it
    serialized

    `publish_once` rather than a reconstruction of it: the envelope
    (`transcriptionHost`, `updatedAt`) is added there, and the point of this
    leg is that no part of the payload is assembled by the test.
    """
    registry = MagicMock(spec=TranscriptionProviderRegistry)
    registry.providers_health = AsyncMock(return_value=REPORT)
    pipeline = _RecordingPipeline()
    redis = MagicMock()
    redis.pipeline = MagicMock(return_value=pipeline)

    publisher = RedisTelemetryPublisher(
        redis,
        ProviderHealthSnapshotService(registry, IDENTITY, CAPACITY_ESTIMATOR),
        MagicMock(spec=Logger),
        HOST_ID,
    )

    import asyncio  # pylint: disable=import-outside-toplevel

    asyncio.run(publisher.publish_once())

    assert pipeline.value is not None, "publisher wrote no snapshot"
    return json.loads(pipeline.value)


def test_manifest_matches_what_the_publisher_serializes(
    published: dict[str, Any],
) -> None:
    """
    The manifest is the publisher's own output, not a hand-written mirror

    Without this, the committed file could drift from the serializer and the
    TypeScript leg would happily keep validating a shape nothing sends -
    exactly the failure mode this whole cross-check exists to close.

    `updatedAt` is stamped from the wall clock and is the one field that
    cannot be pinned; it is checked for type and then overwritten with the
    manifest's value.
    """
    # Arrange
    expected = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    # Act
    actual = dict(published)
    assert isinstance(actual["updatedAt"], int)
    actual["updatedAt"] = expected["updatedAt"]

    # Assert
    assert actual == expected, (
        "tools/telemetry-snapshot-crosscheck/transcription-host-snapshot.json "
        "no longer matches what RedisTelemetryPublisher emits. Regenerate it "
        "from this test's output rather than editing it by hand."
    )


def test_context_ids_are_integers_on_the_wire(
    published: dict[str, Any],
) -> None:
    """
    Pins the specific field two hand-written TypeScript mirrors disagreed about

    `worker_view.serialize_worker` emits `sorted(snapshot.context_ids)` of a
    `set[int]`. The shared schema declared strings and the monitoring
    sidecar's independent restatement declared numbers; the sidecar was right.
    Stated here as its own assertion so the reason the manifest carries
    non-empty `contextIds` survives someone "simplifying" the fixture.
    """
    # Arrange
    workers = published["workers"]

    # Act
    context_ids = workers[0]["contextIds"]

    # Assert - `[1, 8]`, not the `[8, 1]` the source set iterates as, so this
    # pins the `sorted(...)` as well as the element type.
    assert context_ids == [1, 8]
    assert all(isinstance(value, int) for value in context_ids)
    assert not any(isinstance(value, bool) for value in context_ids)


@pytest.mark.asyncio
async def test_a_configured_provider_always_has_a_uid() -> None:
    """
    Pins the invariant the reader's non-nullable `providerUid` rests on

    `ProviderHealthEntry.provider_uid` is typed `str | None` and the registry
    reads it with `self._provider_uids.get(provider_key)`, so *the types on
    both sides disagree*: Python permits null, the TypeScript schema declares
    `Type.String()`, and admin-webapp's hand mirror declares `string`.

    Nothing is broken today, because `_provider_uids` and `self._providers` are
    built from the same `provider_config.providers` dict, so every key present
    in one is present in the other and the `.get` cannot miss. That is a real
    invariant and the stricter schema is the right one - but it is an
    *implicit* invariant holding up a reader that is about to hard-drop what
    fails it, which is the arrangement that produced the `contextIds` bug.

    So it is asserted rather than assumed, including for the provider whose
    health check raises: that path substitutes a synthetic `ProviderHealth`
    and is the one place a reader might expect the identity to go missing.
    """
    # Arrange - one provider that answers and one whose health check raises,
    # since they take different branches of `providers_health`.
    healthy = MagicMock()
    healthy.describe_health = AsyncMock(
        return_value=ProviderHealth(
            kind=ProviderKind.DEBUG, status=ProviderStatus.OK, active_sessions=0
        )
    )
    raising = MagicMock()
    raising.describe_health = AsyncMock(side_effect=RuntimeError("model gone"))

    registry = TranscriptionProviderRegistry.__new__(
        TranscriptionProviderRegistry
    )
    registry._providers = {"debug": healthy, "broken": raising}
    registry._provider_uids = {"debug": "debug", "broken": "whisper-streaming"}
    registry._invalid_provider_key_rejects = 0
    registry._worker_pool = MagicMock()
    registry._worker_pool.worker_snapshots = MagicMock(return_value=[])
    registry._worker_pool.num_workers = 0

    # Act
    report = await registry.providers_health()

    # Assert
    assert {entry.provider_key for entry in report.providers} == {
        "debug",
        "broken",
    }
    for entry in report.providers:
        assert entry.provider_uid is not None, (
            f"provider {entry.provider_key!r} published a null providerUid, "
            "which the reader's schema declares non-nullable"
        )
