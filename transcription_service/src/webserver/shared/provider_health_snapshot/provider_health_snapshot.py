"""
Defines ProviderHealthSnapshotService, the single join behind every surface
that reports this host's provider health
"""

from typing import Any

from src.transcription_provider_interface import ProviderHealth
from src.webserver.shared.process_identity import ProcessIdentity
from src.webserver.shared.transcription_provider_registry import (
    ProviderHealthEntry,
    TranscriptionProviderRegistry,
)
from src.webserver.shared.worker_view import serialize_worker


def _health(health: ProviderHealth) -> dict[str, Any]:
    """
    Serializes one provider's health

    Args:
        health  - Provider health snapshot

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
        "model": health.model,
        "modelLoaded": health.model_loaded,
        "owningWorkers": [
            serialize_worker(snapshot) for snapshot in health.owning_workers
        ],
        "endpoint": health.endpoint,
        "reachable": health.reachable,
        "probeLatencyMs": health.probe_latency_ms,
        "detail": health.detail,
    }


def _provider(entry: ProviderHealthEntry) -> dict[str, Any]:
    """
    Serializes one provider entry, health plus configured identity

    Args:
        entry   - Provider health tagged with its configured identity

    Returns:
        JSON-ready provider entry
    """
    return {"providerUid": entry.provider_uid, **_health(entry.health)}


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
    ):
        """
        Args:
            provider_registry   - Owner of the worker pool and providers
            process_identity    - Identity of this process run, reported so
                                    consumers can tell a restart from a
                                    counter decrease
        """
        self._providers = provider_registry
        self._process_identity = process_identity

    async def snapshot(self) -> dict[str, Any]:
        """
        Gets the current per-provider health snapshot

        `invalidProviderKeyRejects` is monotonic since process start like the
        counters on /metrics/status, so a consumer differences successive reads
        to get a rate - and must compare `processUid` first, because a restart
        returns it to zero and would otherwise read as a large negative rate.
        The uid is the same one /metrics/status reports, so a consumer reading
        both can correlate them.
        """
        report = await self._providers.providers_health()

        return {
            "processUid": self._process_identity.process_uid,
            "processStartedAt": self._process_identity.process_started_at,
            "numWorkers": report.num_workers,
            "invalidProviderKeyRejects": report.invalid_provider_key_rejects,
            "workers": [
                serialize_worker(snapshot) for snapshot in report.workers
            ],
            # Keyed by the configured provider key, verbatim. These are
            # operator-chosen config keys, not part of this schema, so they are
            # never re-cased - the same treatment /metrics/status gives label
            # keys.
            "providers": {
                entry.provider_key: _provider(entry)
                for entry in report.providers
            },
        }
