"""
Serializes worker snapshots into the JSON shape telemetry endpoints report
"""

from typing import Any

from src.shared.utils.worker_pool import WorkerSnapshot


def serialize_worker(snapshot: WorkerSnapshot) -> dict[str, Any]:
    """
    Serializes one worker snapshot

    Args:
        snapshot    - Point-in-time view of a worker

    Returns:
        JSON-ready worker entry

    Shared by `/metrics/status` and `/providers/health` rather than written
    twice. Both report the same worker records to the same consumers, and a
    consumer that has already parsed one should not have to learn a second
    spelling of it - the sidecar restates this shape by hand (Python shares no
    schema package with the Node apps), so drift between the two endpoints
    would surface as a runtime parse failure, not a build error.

    Keys are camelCase, matching every other HTTP JSON API in the fleet. Note
    that this is the telemetry plane; the transcription websocket protocol is
    snake_case, and that asymmetry is deliberate.
    """
    return {
        "workerId": snapshot.worker_id,
        "utilization": snapshot.utilization,
        "liveJobCount": snapshot.live_job_count,
        "totalJobsRegistered": snapshot.total_jobs_registered,
        "contextIds": sorted(snapshot.context_ids),
        # A worker that dies after startup is otherwise invisible: jobs already
        # registered to it never return and never raise. See B1.3.
        "alive": snapshot.alive,
        # Per-job correlation to the caller's own session/room identifiers, so
        # an operator can see what a worker is actively processing rather than
        # only the aggregate liveJobCount. Opaque to this service; forwarded
        # verbatim from register_job (B1.7 follow-up, part 2).
        "activeJobs": [
            {
                "jobId": job.job_id,
                "sessionUid": job.session_uid,
                "roomUid": job.room_uid,
            }
            for job in snapshot.active_jobs
        ],
    }
