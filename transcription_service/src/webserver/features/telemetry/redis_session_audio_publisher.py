"""
Defines RedisSessionAudioPublisher that publishes per-session audio-level
stats to the fleet telemetry backplane (B2.1)
"""

import asyncio
import json
import time

from redis.asyncio import Redis

from src.shared.logger import Logger
from src.shared.utils.audio_meter import AudioLevelStats

from .telemetry_keys import (
    AUDIO_STATS_TTL_MS,
    TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
    transcription_session_audio_key,
)


class RedisSessionAudioPublisher:
    """
    Publishes a live session's latest audio-level meter readout to Redis
    (B2.1 / plan §3)

    **Push-based, not a beat.** Unlike `RedisTelemetryPublisher` - host-level
    and pull-based, reading live worker-pool state from the main process on a
    fixed 5s timer - there is no live per-session audio state in the main
    process to pull: `AudioLevelStats` only exists transiently, attached to
    whatever `TranscriptionResult` a worker execution just produced. So this
    publisher is a process-singleton that every WebSocket connection's result
    listener calls into, one Redis write per event rather than one process
    per beat.

    **Throttled per session.** `process_batch` can run more often than any
    sane Redis write rate (a fast `job_period_ms`), so writes for a given
    session_uid are dropped rather than queued when they arrive faster than
    `min_publish_interval_sec` - the next event still carries a fresh
    reading, so nothing is lost but frequency.

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

    def publish(
        self,
        session_uid: str | None,
        room_uid: str | None,
        stats: AudioLevelStats,
    ) -> None:
        """
        Fire-and-forget publish of one session's audio-level snapshot

        No-ops immediately, before scheduling anything, if session_uid is
        None (nothing to key by - an older node-server peer, or a session
        opened before the CONFIG message carried session_uid) or if this
        session published within the last min_publish_interval_sec.

        Args:
            session_uid  - Opaque session identifier, or None if unknown
            room_uid     - Opaque room identifier, or None if unknown
            stats        - Snapshot to publish
        """
        if session_uid is None:
            return

        now = time.time()
        last = self._last_published.get(session_uid)
        if last is not None and now - last < self._min_publish_interval_sec:
            return
        self._last_published[session_uid] = now

        asyncio.create_task(self._publish_once(session_uid, room_uid, stats))

    def forget(self, session_uid: str | None) -> None:
        """
        Drops this session's throttle-tracking state

        Call on session close, so the tracking dict does not grow with the
        number of sessions ever served over the process's lifetime - the same
        lifetime rule WorkerProcessManager._job_labels already established.
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
        self, session_uid: str, room_uid: str | None, stats: AudioLevelStats
    ) -> None:
        """
        Performs the actual write: a snapshot key, its index entry, and a
        prune of the index - same snapshot-plus-index shape every other
        publisher in this backplane uses.
        """
        try:
            now = int(time.time() * 1000)
            record = {
                "rmsDbfs": stats.rms_dbfs,
                "peakDbfs": stats.peak_dbfs,
                "clippingPct": stats.clipping_pct,
                "silence": stats.silence,
                "noiseFloorDbfs": stats.noise_floor_dbfs,
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
