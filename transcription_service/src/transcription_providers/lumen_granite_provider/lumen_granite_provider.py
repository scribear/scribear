"""
Defines LumenGraniteProvider.

A remote, OpenAI-compatible transcription backend (wiki "Recipe B") that
forwards buffered audio to NCSA Lumen's `granite-speech-4.1-2b-plus` model. It
needs no local model/context, so its job registers with an empty context tag
tuple. Provider-wide config (endpoint, model, key env var, windowing) is shared
by every session; per-session `session_config` is ignored.
"""

# The provider/session wiring necessarily mirrors the other providers.
# pylint: disable=duplicate-code

import os
import time

import httpx

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobException, JobSuccess, WorkerPool
from src.transcription_provider_interface import (
    AudioChunkPayload,
    ProviderHealth,
    ProviderKind,
    ProviderStatus,
    TranscriptionProviderInterface,
    TranscriptionResult,
    TranscriptionSessionInterface,
)

from .lumen_granite_config import lumen_granite_config_adapter
from .lumen_granite_job import LumenGraniteProviderJob

# How long a reachability probe result is reused. The dashboard polls provider
# health continuously and every operator browser multiplies that, so an
# uncached probe would turn a monitoring page into a load generator pointed at
# a third party's endpoint.
PROBE_TTL_SEC = 10.0

# Bounded well under the dashboard's poll interval: a hung endpoint must make
# the probe report "unreachable", not make the health request hang.
PROBE_TIMEOUT_SEC = 5.0


class LumenGraniteProvider(TranscriptionProviderInterface):
    """
    TranscriptionProvider that transcribes audio via NCSA Lumen's Granite
    Speech model over its OpenAI-compatible HTTP endpoint.
    """

    class _LumenGraniteSession(TranscriptionSessionInterface):
        """
        Transcription session interface for LumenGraniteProvider.
        """

        def __init__(
            self,
            provider: "LumenGraniteProvider",
            logger: Logger,
            session_uid: str | None,
            room_uid: str | None,
        ):
            super().__init__()
            self._log = logger
            self._provider = provider
            # Opaque; stored for a future consumer (Part 2), not read here.
            self.session_uid = session_uid
            self.room_uid = room_uid

            # Not registered here - see _ensure_job. An idle client that never
            # sends audio must never take a worker's job slot.
            self._job = None

            provider.session_started()

        def _handle_job_result(
            self, result: JobSuccess[TranscriptionResult] | JobException
        ):
            if result.has_exception is True:
                self.emit(self.TranscriptionErrorEvent, result.value)
                return

            self.emit(self.TranscriptionResultEvent, result.value)

        def _ensure_job(self) -> None:
            """
            Registers this session's worker-pool job on the first real audio
            chunk, not at construction

            Deferred so an idle client - configured but never streaming - never
            takes a worker's job slot, and so never counts toward that
            worker's live_job_count for capacity admission. `check_admission`
            is called for uniformity with the other two providers' sessions,
            not because it can refuse one here: this session never overrides
            `admission_worker_id`, so the call is a guaranteed no-op (see
            TranscriptionSessionInterface.admission_worker_id) - a remote
            provider's capacity question is upstream rate limits and network
            latency, explicitly out of scope per §5/§7.
            """
            if self._job is not None:
                return

            self._job = self._provider.worker_pool.register_job(
                (),  # no context - remote endpoint does the work
                self._provider.config.job_period_ms,
                LumenGraniteProviderJob(self._provider.config),
                self._provider.provider_key,
                session_uid=self.session_uid,
                room_uid=self.room_uid,
            )
            self._job.on(self._job.JobResultEvent, self._handle_job_result)
            self._provider.check_admission(self.admission_worker_id, self._log)

        def handle_audio_chunk(self, chunk_id: str, chunk: bytes):
            self._ensure_job()
            self._job.queue_data(
                [AudioChunkPayload(chunk_id=chunk_id, audio_bytes=chunk)]
            )

        def end_session(self):
            super().end_session()
            if self._job is not None:
                self._job.deregister()
            self._provider.session_ended()

    def __init__(
        self,
        provider_config: object,
        logger: Logger,
        worker_pool: WorkerPool,
        provider_key: str,
    ):
        self._log = logger
        self.config = lumen_granite_config_adapter.validate_python(
            provider_config
        )
        self.worker_pool = worker_pool
        self.provider_key = provider_key

        # Per instance, not per class: two lumen providers can be configured
        # against different endpoints, and a shared cache would report one's
        # reachability as the other's.
        self._probe_cache: (
            tuple[float, bool, float | None, bool | None, str | None] | None
        )
        self._probe_cache = None

    @property
    def job_period_ms(self) -> int | None:
        # The same field the session passes to register_job, read from the same
        # config object, so the reported period cannot drift from the scheduled
        # one.
        return self.config.job_period_ms

    def create_session(
        self,
        session_config: object,
        session_uid: str | None,
        room_uid: str | None,
        logger: Logger,
    ):
        del session_config  # per-session config is ignored; see module docstring
        return self._LumenGraniteSession(self, logger, session_uid, room_uid)

    async def _probe_endpoint(
        self,
    ) -> tuple[bool, float | None, bool | None, str | None]:
        """
        Checks whether the upstream endpoint is answering, with caching

        Returns:
            (reachable, latency_ms, model_loaded, detail)
        """
        now = time.monotonic()
        if self._probe_cache is not None and self._probe_cache[0] > now:
            _, reachable, latency_ms, model_loaded, detail = self._probe_cache
            return (reachable, latency_ms, model_loaded, detail)

        reachable, latency_ms, model_loaded, detail = (
            await self._measure_endpoint()
        )
        self._probe_cache = (
            now + PROBE_TTL_SEC,
            reachable,
            latency_ms,
            model_loaded,
            detail,
        )
        return (reachable, latency_ms, model_loaded, detail)

    async def _measure_endpoint(
        self,
    ) -> tuple[bool, float | None, bool | None, str | None]:
        """
        Performs one uncached reachability check

        Returns:
            (reachable, latency_ms, model_loaded, detail)
        """
        # A missing key is a configuration error, not a network condition, so
        # it is answered without a request. This is also what makes the
        # endpoint safe to poll in a deployment that never configured lumen.
        env_var = self.config.api_key_env
        api_key = os.environ.get(env_var) if env_var else None
        if not env_var or not api_key:
            return (False, None, None, f"api key env '{env_var}' is not set")

        # `{base_url}` alone 404s; the models route is the cheapest endpoint
        # that both requires and validates the bearer token, so it doubles as
        # an auth check rather than just a bare-TCP liveness check.
        url = self.config.base_url.rstrip("/") + "/models"
        try:
            started = time.monotonic()
            async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SEC) as client:
                response = await client.get(
                    url, headers={"Authorization": f"Bearer {api_key}"}
                )
            latency_ms = (time.monotonic() - started) * 1000
        except (httpx.HTTPError, OSError) as error:
            # The class and message, because this is the operator's only clue
            # about *how* the endpoint is unreachable - a timeout and a DNS
            # failure need different fixes.
            return (False, None, None, f"{type(error).__name__}: {error}")

        # A bearer token is now on the request, so 401/403 is no longer mere
        # liveness noise - it means the upstream rejected our key, which is
        # exactly the failure an operator needs surfaced.
        if response.status_code in (401, 403):
            return (
                False,
                latency_ms,
                None,
                f"upstream rejected API key ({response.status_code})",
            )
        if response.status_code >= 500:
            return (
                False,
                latency_ms,
                None,
                f"upstream returned {response.status_code}",
            )

        model_loaded, model_detail = self._check_model_listed(response)
        return (True, latency_ms, model_loaded, model_detail)

    def _check_model_listed(
        self, response: httpx.Response
    ) -> tuple[bool | None, str | None]:
        """
        Checks whether the configured model appears in an OpenAI-style
        `{"data": [{"id": ...}, ...]}` models listing

        Returns:
            (model_loaded, detail) - model_loaded is None when the body
            doesn't match that shape, so a nonstandard listing cannot flip an
            otherwise-healthy endpoint to a false negative.
        """
        try:
            listed_ids = {entry["id"] for entry in response.json()["data"]}
        except (ValueError, KeyError, TypeError):
            return (None, None)

        if self.config.model in listed_ids:
            return (True, None)
        return (
            False,
            f"configured model '{self.config.model}' not found in "
            "upstream /models list",
        )

    async def describe_health(self):
        """
        Gets health of this remote provider

        The reachability probe is cached for `PROBE_TTL_SEC`, so a dashboard
        polling this in a loop cannot add measurable load to the upstream or
        latency to active transcription.
        """
        reachable, latency_ms, model_loaded, detail = (
            await self._probe_endpoint()
        )
        # An unreachable/unauthenticated endpoint is DOWN outright; reachable
        # with the configured model missing from its listing is DEGRADED
        # rather than DOWN, since the endpoint is answering and the model may
        # still work even if unlisted (or missing from a shape we don't
        # recognize) - unlike LOCAL providers, there is no direct way to know
        # whether the model actually loads without transcribing through it.
        if not reachable:
            status = ProviderStatus.DOWN
        elif model_loaded is False:
            status = ProviderStatus.DEGRADED
        else:
            status = ProviderStatus.OK
        return ProviderHealth(
            kind=ProviderKind.REMOTE,
            status=status,
            active_sessions=self.active_sessions,
            model=self.config.model,
            model_loaded=model_loaded,
            endpoint=self.config.base_url,
            reachable=reachable,
            probe_latency_ms=latency_ms,
            detail=detail,
        )

    def cleanup_provider(self):
        pass
