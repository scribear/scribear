"""
Evaluates readiness of the transcription service
"""

from dataclasses import dataclass

from src.shared.utils.worker_pool.worker_process_manager import (
    WorkerSnapshot,
    is_saturated,
)


@dataclass(frozen=True)
class ReadinessReport:
    """
    Outcome of a readiness evaluation

    `ready` drives the HTTP status; `degraded` is reported alongside a 200,
    because a saturated pool is still a working pool.
    """

    ready: bool
    degraded: bool
    checks: dict[str, str]


def evaluate_readiness(snapshots: list[WorkerSnapshot]) -> ReadinessReport:
    """
    Decides whether the worker pool can still serve transcription

    Args:
        snapshots - Point-in-time view of every worker in the pool

    Returns:
        ReadinessReport

    **Not ready** means a hard fault that shedding load will not fix:

    - No workers at all, which should be impossible after a successful startup
      but is the difference between "pool empty" and "pool busy".
    - A worker process has died. Jobs already registered to it will never
      return and never raise - the result-queue poll loop just times out
      forever - so a dead worker silently swallows every session pinned to its
      context. This is the T9 signature and, before B1.3, nothing detected it.

    **Degraded** means every live worker is pinned at
    `SATURATION_UTILIZATION` or above. That is deliberately *not* a 503: the
    service is doing exactly what it should under load, and failing readiness
    would take it out of rotation at its busiest moment - the classic
    self-inflicted outage. Callers that route on readiness keep routing;
    callers that display it show amber.
    """
    if len(snapshots) == 0:
        return ReadinessReport(
            ready=False,
            degraded=False,
            checks={"workers": "no worker processes in the pool"},
        )

    dead = [s for s in snapshots if not s.alive]
    if len(dead) > 0:
        stranded = sum(s.live_job_count for s in dead)
        ids = ", ".join(str(s.worker_id) for s in dead)
        return ReadinessReport(
            ready=False,
            degraded=False,
            checks={
                "workers": (
                    f"{len(dead)} of {len(snapshots)} worker processes have "
                    f"exited (worker ids: {ids}); {stranded} in-flight jobs "
                    "will never complete"
                )
            },
        )

    # `is_saturated` carries the cold-start caveat: a worker that has recorded
    # busy time but no idle time yet reports 1.0, so utilization alone would
    # call every fresh boot saturated. Shared with per-provider health (B1.7)
    # so the two surfaces cannot disagree about the word.
    saturated = [s for s in snapshots if is_saturated(s)]
    if len(saturated) == len(snapshots):
        worst = max(s.utilization for s in snapshots)
        return ReadinessReport(
            ready=True,
            degraded=True,
            checks={
                "workers": (
                    f"all {len(snapshots)} workers saturated "
                    f"(rolling utilization up to {worst:.2f}); "
                    "transcription will fall behind realtime"
                )
            },
        )

    return ReadinessReport(ready=True, degraded=False, checks={})
