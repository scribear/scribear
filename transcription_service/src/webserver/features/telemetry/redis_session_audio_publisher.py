"""
Defines RedisSessionAudioPublisher that publishes a per-session graph of audio
measurement points to the fleet telemetry backplane (B2.1 / B2.2, plan §12.4)
"""

import asyncio
import json
import time
from typing import Any, Sequence

from redis.asyncio import Redis

from src.shared.logger import Logger

from .audio_stage_graph import ResolvedAudioStage
from .telemetry_keys import (
    AUDIO_STATS_TTL_MS,
    TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
    transcription_session_audio_key,
)


def _stage_record(stage: ResolvedAudioStage) -> dict[str, Any]:
    """
    Serialises one measurement point into the wire shape of §12.4

    Keys are camelCase because the readers are TypeScript, and the level/VAD
    field names are the ones B2.1/B2.2 already shipped - unchanged on purpose,
    so this reshaping costs the dashboard only the nesting and not a rename of
    every number in it. `levels` and `vad` are null rather than absent when a
    stage does not produce them: a stage may legitimately count throughput
    without metering, or meter without running a detector, and null says
    "not measured here" where a missing key says "this payload is a different
    version".

    Args:
        stage - Measurement point with its depth already resolved

    Returns:
        A JSON-serialisable dict of plain scalars.
    """
    reading = stage.reading
    levels = reading.levels
    vad = reading.vad
    return {
        "stage": reading.stage,
        "label": reading.label,
        "depth": stage.depth,
        "inputs": list(reading.inputs),
        "levels": (
            {
                "rmsDbfs": levels.rms_dbfs,
                "peakDbfs": levels.peak_dbfs,
                "clippingPct": levels.clipping_pct,
                "silence": levels.silence,
                "noiseFloorDbfs": levels.noise_floor_dbfs,
            }
            if levels is not None
            else None
        ),
        "vad": (
            {
                "vadEnabled": vad.vad_enabled,
                "speechActiveRatio": vad.speech_active_ratio,
                "segmentCount": vad.segment_count,
                "meanSegmentDurationSec": vad.mean_segment_duration_sec,
                "speechToPauseRatio": vad.speech_to_pause_ratio,
                "snrDb": vad.snr_db,
            }
            if vad is not None
            else None
        ),
        "audioSeconds": reading.audio_seconds,
    }


class RedisSessionAudioPublisher:
    """
    Publishes a live session's latest per-stage audio telemetry to Redis
    (B2.1/B2.2 / plan §3, §12.4)

    **Push-based, not a beat.** Unlike `RedisTelemetryPublisher` - host-level
    and pull-based, reading live worker-pool state from the main process on a
    fixed 5s timer - there is no single place to pull a session's audio
    telemetry from: part of it is the webserver's own ingress meter and part of
    it only exists transiently, attached to whatever `TranscriptionResult` a
    worker execution just produced. So this publisher is a process-singleton
    that every WebSocket connection calls into, one Redis write per event
    rather than one process per beat.

    **Throttled per session.** Callers publish far more often than any sane
    Redis write rate - a chunk arrives ~10/s and `process_batch` runs on its
    own `job_period_ms` - so writes for a given session_uid are dropped rather
    than queued when they arrive faster than `min_publish_interval_sec`. The
    next event still carries a fresh reading, so nothing is lost but
    frequency. `is_due` exposes the same decision to a caller whose payload is
    expensive to assemble, so the interval stays defined in exactly one place.

    **Never blocks the caller.** `publish()` is called from inside a
    WebSocket event-handler callback on the running event loop; the actual
    Redis write happens on a detached task so a slow or down backplane costs
    the dashboard freshness and costs the session nothing - same "every
    failure here is the dashboard's problem, never a session's" rule
    `RedisTelemetryPublisher.publish_once` documents and follows.
    """

    def __init__(
        self,
        redis_client: Redis,
        logger: Logger,
        transcription_host_id: str,
        min_publish_interval_sec: float = 2.0,
    ):
        """
        Args:
            redis_client                - Connection to the telemetry backplane
            logger                       - Application logger
            transcription_host_id        - Identity this host publishes under,
                                             same value RedisTelemetryPublisher
                                             reports, already validated to be
                                             ':'-free
            min_publish_interval_sec     - Minimum seconds between writes for
                                             the same session_uid
        """
        self._redis = redis_client
        self._logger = logger
        self._transcription_host_id = transcription_host_id
        self._min_publish_interval_sec = min_publish_interval_sec
        # session_uid -> epoch seconds of that session's last publish.
        self._last_published: dict[str, float] = {}

    def is_due(self, session_uid: str | None) -> bool:
        """
        Whether a `publish` for this session would be written rather than
        dropped by the throttle

        Exists for callers whose payload costs real work to assemble - an
        ingress `AudioMeter.snapshot()` is ~218 us against ~29 us to meter a
        chunk (§12.9), so computing one per chunk to have it thrown away by the
        throttle would cost an order of magnitude more than the metering it
        reports on. Asking here keeps the interval a single source of truth: a
        caller that kept its own timer would drift from this one and either
        starve the dashboard or pay the cost anyway.

        Advisory, not a contract - `publish` re-checks the throttle itself, so
        a caller that skips this call still cannot write faster than the
        interval allows.

        Args:
            session_uid - Opaque session identifier, or None if unknown

        Returns:
            False when there is nothing to key by, otherwise whether this
            session's throttle window has elapsed.
        """
        if session_uid is None:
            return False

        last = self._last_published.get(session_uid)
        return (
            last is None or time.time() - last >= self._min_publish_interval_sec
        )

    def publish(
        self,
        session_uid: str | None,
        room_uid: str | None,
        stages: Sequence[ResolvedAudioStage],
    ) -> None:
        """
        Fire-and-forget publish of one session's audio-telemetry graph

        No-ops immediately, before scheduling anything, if session_uid is
        None (nothing to key by - an older node-server peer, or a session
        opened before the CONFIG message carried session_uid) or if this
        session published within the last min_publish_interval_sec.

        Every stage folds into the same envelope/publish - one Redis key, one
        write, not a key per stage: the point of the graph is comparing one
        stage's `audio_seconds` against its neighbour's, and a reader that
        could observe one stage without the others would compute a signal loss
        that never happened. That is the same reasoning that kept VAD stats on
        this key rather than a second one in B2.2; they now travel as a field
        of whichever stage produced them.

        Args:
            session_uid  - Opaque session identifier, or None if unknown
            room_uid     - Opaque room identifier, or None if unknown
            stages       - Measurement points with their depths already
                             resolved, in the order they should be read
        """
        if session_uid is None:
            return

        now = time.time()
        last = self._last_published.get(session_uid)
        if last is not None and now - last < self._min_publish_interval_sec:
            return
        self._last_published[session_uid] = now

        asyncio.create_task(
            self._publish_once(session_uid, room_uid, tuple(stages))
        )

    def forget(self, session_uid: str | None) -> None:
        """
        Drops this session's throttle-tracking state

        Call on session close, so the tracking dict does not grow with the
        number of sessions ever served over the process's lifetime - the same
        lifetime rule WorkerProcessManager._job_correlation already
        establishes for bookkeeping nothing else needs after a job ends.
        A session_uid forgotten here publishes immediately on its next
        `publish()` call, regardless of prior timing; that is fine, because
        forgetting only happens once the session that owned the throttle
        window is gone.

        Args:
            session_uid - Opaque session identifier, or None (a no-op)
        """
        if session_uid is None:
            return
        self._last_published.pop(session_uid, None)

    async def aclose(self) -> None:
        """
        Closes the shared Redis connection at app shutdown

        The keys this publisher wrote are deliberately left behind: each
        expires within seconds on its own, same as the host snapshot's
        teardown - liveness is expiry, not an explicit delete.
        """
        await self._redis.aclose()

    async def _publish_once(
        self,
        session_uid: str,
        room_uid: str | None,
        stages: tuple[ResolvedAudioStage, ...],
    ) -> None:
        """
        Performs the actual write: a snapshot key, its index entry, and a
        prune of the index - same snapshot-plus-index shape every other
        publisher in this backplane uses.
        """
        try:
            now = int(time.time() * 1000)
            record = {
                "stages": [_stage_record(stage) for stage in stages],
                "sessionUid": session_uid,
                "roomUid": room_uid,
                "transcriptionHost": self._transcription_host_id,
                "updatedAt": now,
            }

            # A pipeline, not a transaction: these writes have no invariant
            # between them a reader could observe being broken - each is an
            # idempotent overwrite of what the next publish writes again - so
            # a transaction would only buy blocking semantics nobody needs.
            beat = self._redis.pipeline(transaction=False)
            beat.set(
                transcription_session_audio_key(session_uid),
                json.dumps(record),
                px=AUDIO_STATS_TTL_MS,
            )
            beat.zadd(TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY, {session_uid: now})
            # Sorted-set members carry no TTL of their own, so the index
            # would otherwise grow forever with the identity of every session
            # ever served. Pruning is by score and not scoped to this
            # session: whoever publishes next drops whatever has expired.
            beat.zremrangebyscore(
                TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
                0,
                now - AUDIO_STATS_TTL_MS,
            )
            await beat.execute()
        except Exception as error:  # pylint: disable=broad-exception-caught
            # Every failure here is the dashboard's problem, never a
            # session's - Redis down, misconfigured or slow costs this
            # session's audio panel its freshness and nothing else.
            self._logger.warning(
                "Audio-stats publish failed for session",
                context={"sessionUid": session_uid, "error": str(error)},
            )
