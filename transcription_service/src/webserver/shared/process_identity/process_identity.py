"""
Defines ProcessIdentity, the identity every telemetry endpoint reports
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class ProcessIdentity:
    """
    Identifies one run of this process to telemetry consumers

    Every counter this service reports is monotonic since process start and
    nothing is persisted, so a consumer differences successive reads to obtain
    a rate. That arithmetic is only valid within one run: a restart returns
    every counter to zero, which reads as a large negative rate unless the
    consumer notices the process changed first.

    Constructed once and shared by every telemetry surface rather than minted
    per endpoint. Two endpoints reporting two different uids for the same
    process would make cross-endpoint correlation impossible - which is the
    entire point of reporting it.
    """

    process_uid: str
    process_started_at: str


def create_process_identity() -> ProcessIdentity:
    """
    Creates the identity for the current process

    Returns:
        ProcessIdentity with a fresh uid and the current UTC timestamp
    """
    return ProcessIdentity(
        process_uid=str(uuid.uuid4()),
        process_started_at=datetime.now(timezone.utc).isoformat(),
    )
