"""
Defines ProviderHealthSnapshotService, the single join behind every surface
that reports this host's provider health
"""

from typing import Any

from src.shared.utils.worker_pool import CapacityEstimator, WorkerSnapshot
from src.transcription_provider_interface import ProviderHealth
from src.webserver.shared.metrics import MetricsRegistry
from src.webserver.shared.process_identity import ProcessIdentity
from src.webserver.shared.transcription_provider_registry import (
    ProviderHealthEntry,
    TranscriptionProviderRegistry,
)
from src.webserver.shared.worker_view import serialize_worker


def _worker(
    snapshot: WorkerSnapshot, capacity_estimator: CapacityEstimator
) -> dict[str, Any]:
    """
    Serializes one worker snapshot with its capacity estimate layered on

    Args:
        snapshot            - Point-in-time view of a worker
        capacity_estimator  - Per-worker capacity estimator
                                (PLAN-AdmissionControl.md §3/§5)

    Returns:
        JSON-ready worker entry

    Identical to how MetricsController.status() layers this onto
    /metrics/status's `workers[]` - N* by a completely separate observer, not
    a WorkerSnapshot field, so this stays independent of what the pool itself
    reports. None means "not measured yet" (warm-up), never zero or
    unlimited.
    """
    return {
        **serialize_worker(snapshot),
        "estimatedCapacitySessions": (
            capacity_estimator.snapshot(
                snapshot.worker_id, snapshot.live_job_count
            ).estimated_capacity_sessions
        ),
    }


def _health(
    health: ProviderHealth,
    capacity_estimator: CapacityEstimator,
    provider_key: str,
    metrics_registry: MetricsRegistry,
) -> dict[str, Any]:
    """
    Serializes one provider's health

    Args:
        health              - Provider health snapshot
        capacity_estimator  - Per-worker capacity estimator, merged onto each
                                owning worker (PLAN-AdmissionControl.md §5)
        provider_key         - Configured key this provider is registered
                                under, used to look up its refusal count
        metrics_registry     - Process-wide metrics store, read here for
                                `sessions_refused_capacity_total`
                                (PLAN-AdmissionControl.md §4)

    Returns:
        JSON-ready health entry

    Every field is always present, with null where it does not apply to the
    provider's kind, rather than being omitted. A fixed shape is what lets a
    consumer declare all fields required and so catch schema drift at parse
    time; with optional fields, a field this service stopped sending would read
    as a legitimately absent value instead of as a bug.
    """
    return {
        "kind": health.kind.value,
        "status": health.status.value,
        "activeSessions": health.active_sessions,
        "sessionsRefusedCapacityTotal": int(
            metrics_registry.sessions_refused_capacity_total.get(
                {"provider_key": provider_key}
            )
        ),
        "model": health.model,
        "modelLoaded": health.model_loaded,
        "owningWorkers": [
            _worker(snapshot, capacity_estimator)
            for snapshot in health.owning_workers
        ],
        "endpoint": health.endpoint,
        "reachable": health.reachable,
        "probeLatencyMs": health.probe_latency_ms,
        "detail": health.detail,
    }


def _provider(
    entry: ProviderHealthEntry,
    capacity_estimator: CapacityEstimator,
    metrics_registry: MetricsRegistry,
) -> dict[str, Any]:
    """
    Serializes one provider entry, health plus configured identity

    Args:
        entry               - Provider health tagged with its configured
                                identity
        capacity_estimator  - Per-worker capacity estimator, forwarded to
                                _health()
        metrics_registry     - Process-wide metrics store, forwarded to
                                _health()

    Returns:
        JSON-ready provider entry
    """
    return {
        "providerUid": entry.provider_uid,
        **_health(
            entry.health,
            capacity_estimator,
            entry.provider_key,
            metrics_registry,
        ),
    }


class ProviderHealthSnapshotService:
    """
    Builds this host's provider health snapshot

    Two consumers want the same answer: `GET /providers/health` serves it over
    HTTP to whoever asks, and the Redis telemetry publisher writes it to the
    fleet backplane on a timer. The join lives here rather than in either of
    them because it belongs to neither - assembling it twice would let the
    published record and the HTTP body drift apart, and the dashboard cannot
    tell which of the two is lying.

    Reads only: local providers touch in-memory state and remote providers
    answer from a cached probe, so taking a snapshot - however often - can never
    perturb an active transcription.
    """

    def __init__(
        self,
        provider_registry: TranscriptionProviderRegistry,
        process_identity: ProcessIdentity,
        capacity_estimator: CapacityEstimator,
        metrics_registry: MetricsRegistry,
    ):
        """
        Args:
            provider_registry   - Owner of the worker pool and providers
            process_identity    - Identity of this process run, reported so
                                    consumers can tell a restart from a
                                    counter decrease
            capacity_estimator  - Per-worker capacity estimator
                                    (PLAN-AdmissionControl.md §3). Read here
                                    through snapshot() only, same as
                                    MetricsController - this service must stay
                                    side effect free so a poll can never move
                                    a decision. create_webserver.py always
                                    constructs one, so this is required rather
                                    than optional.
            metrics_registry     - Process-wide metrics store
                                    (PLAN-AdmissionControl.md §4). Threaded
                                    through for the same reason as
                                    capacity_estimator above: both
                                    `/providers/health` and the Redis
                                    publisher need
                                    `sessionsRefusedCapacityTotal` reported
                                    next to `activeSessions`, and this service
                                    is the one join both consumers share.
                                    Read here through snapshot() only, so this
                                    stays side effect free the same way.
                                    create_webserver.py always constructs one,
                                    so this is required rather than optional.
        """
        self._providers = provider_registry
        self._process_identity = process_identity
        self._capacity_estimator = capacity_estimator
        self._metrics_registry = metrics_registry

    async def snapshot(self) -> dict[str, Any]:
        """
        Gets the current per-provider health snapshot

        `invalidProviderKeyRejects` is monotonic since process start like the
        counters on /metrics/status, so a consumer differences successive reads
        to get a rate - and must compare `processUid` first, because a restart
        returns it to zero and would otherwise read as a large negative rate.
        The uid is the same one /metrics/status reports, so a consumer reading
        both can correlate them.

        Each provider's `sessionsRefusedCapacityTotal` carries the identical
        caveat: it too is monotonic since process start and resets to zero on
        restart, so a consumer must compare `processUid` before differencing it
        across polls, exactly as for `invalidProviderKeyRejects` above.
        """
        report = await self._providers.providers_health()

        return {
            "processUid": self._process_identity.process_uid,
            "processStartedAt": self._process_identity.process_started_at,
            "numWorkers": report.num_workers,
            "invalidProviderKeyRejects": report.invalid_provider_key_rejects,
            "workers": [
                _worker(snapshot, self._capacity_estimator)
                for snapshot in report.workers
            ],
            # Keyed by the configured provider key, verbatim. These are
            # operator-chosen config keys, not part of this schema, so they are
            # never re-cased - the same treatment /metrics/status gives label
            # keys.
            "providers": {
                entry.provider_key: _provider(
                    entry, self._capacity_estimator, self._metrics_registry
                )
                for entry in report.providers
            },
        }
