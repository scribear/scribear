"""
Defines the per-provider health snapshot reported by GET /providers/health
"""

from dataclasses import dataclass, field
from enum import StrEnum

from src.shared.utils.worker_pool import WorkerSnapshot


class ProviderKind(StrEnum):
    """
    Taxonomy a provider belongs to, which decides what can be measured

    LOCAL providers need a model context pinned to a worker and can therefore
    report whether that model actually loaded; REMOTE providers own no context
    and are instead judged by whether their endpoint answers. DEBUG needs
    neither and exists as a control.
    """

    LOCAL = "local"
    REMOTE = "remote"
    DEBUG = "debug"
    # Only reached when describe_health itself raised, so the registry knows a
    # provider is unwell but not what kind it was.
    UNKNOWN = "unknown"


class ProviderStatus(StrEnum):
    """
    Health verdict for one provider

    DEGRADED is deliberately distinct from DOWN: a saturated local provider is
    still transcribing, just not keeping up, and an operator triages those two
    very differently. This mirrors the ready/degraded split the readiness probe
    already makes about the pool as a whole (see probes_controller).
    """

    OK = "ok"
    DEGRADED = "degraded"
    DOWN = "down"


@dataclass(frozen=True)
class ProviderHealth:
    """
    One provider's health snapshot

    Cheap to compute: the local path only reads in-memory counters and worker
    state, and the remote path is a probe cached for `PROBE_TTL_SEC`, so
    polling this endpoint cannot add latency to active transcription.

    Fields that do not apply to a kind stay None rather than being omitted.
    The response shape is therefore fixed, which is what lets a consumer
    declare every field required and catch drift at parse time - the lesson the
    monitoring sidecar wrote down when it restated the /metrics/status body.
    """

    kind: ProviderKind
    status: ProviderStatus
    active_sessions: int

    # Model name, when the provider knows it. Local providers generally do not:
    # the name lives on the *context* config (faster_whisper_context), not on
    # the provider config, and a provider only holds a tag that routes to it.
    model: str | None = None

    # Local only. A provider whose contexts no live worker owns is down however
    # healthy the pool looks - this is the mis-set worker_ids/tags failure that
    # readiness cannot see, because the pool itself is fine.
    model_loaded: bool | None = None
    owning_workers: list[WorkerSnapshot] = field(default_factory=list)

    # Remote only.
    endpoint: str | None = None
    reachable: bool | None = None
    probe_latency_ms: float | None = None

    # Last error or explanatory note, for any kind. Free text for an operator;
    # never parsed.
    detail: str | None = None
