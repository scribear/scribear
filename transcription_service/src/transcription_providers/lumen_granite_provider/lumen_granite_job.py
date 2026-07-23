"""
Defines WorkerPool job for LumenGraniteProvider.

The job buffers incoming audio and, every job period, encodes the current
window as a WAV and POSTs it to Lumen's OpenAI-compatible transcription route,
emitting the returned text. Because Lumen offers no server-side streaming and
no timestamps, finalization is done here: the running transcript is surfaced as
`in_progress` (which replaces the previous in-progress text each period), and
once the buffered audio reaches the configured maximum the transcript is
committed as a `final` segment and the window is reset.

The blocking HTTP request deliberately runs inside `process_batch` (a worker
subprocess fired on a timer) rather than on the WebSocket event loop.
"""

# The audio-decode loop necessarily mirrors the other providers' jobs.
# pylint: disable=duplicate-code

import io
import os

import numpy as np
import requests
import soundfile as sf

from src.shared.logger import Logger
from src.shared.utils.audio_decoder import AudioDecoder, TargetFormat
from src.shared.utils.np_circular_buffer import NPCircularBuffer
from src.shared.utils.worker_pool import JobInterface
from src.transcription_provider_interface import (
    AudioChunkPayload,
    JobCounterCollector,
    TranscriptionClientError,
    TranscriptionJobCounter,
    TranscriptionResult,
    TranscriptionSequence,
)

from .lumen_granite_config import LumenGraniteProviderConfig


class LumenGraniteProviderJob(
    JobInterface[tuple, AudioChunkPayload, TranscriptionResult, None]
):
    """
    WorkerPool job definition for LumenGraniteProvider.

    Uses no context (empty tag tuple) - all work is a network call to Lumen.
    """

    def __init__(self, config: LumenGraniteProviderConfig):
        # Instrumenting only whisper would produce a dashboard that goes quiet
        # when a deployment switches providers.
        self._counters = JobCounterCollector()

        self._config = config
        self._decoder = AudioDecoder(
            config.sample_rate, config.num_channels, TargetFormat.FLOAT_32
        )

        self._max_buffer_samples = int(
            config.sample_rate * config.max_buffer_len_sec
        )
        # Size the buffer larger than the commit threshold so a period's worth
        # of audio can arrive before we force finalization.
        self._buffer = NPCircularBuffer(
            self._max_buffer_samples * 2, dtype=np.float32
        )

        # Ids of the source chunks currently represented in the window, reset
        # whenever the window is committed. Lets a transcript be correlated back
        # to the audio frames that produced it for latency measurement.
        self._window_chunk_ids: list[str] = []

        # Resolve the upstream key once, inside the worker process where the
        # env var is available. Missing key surfaces as a client error at
        # request time rather than crashing the worker at startup.
        self._api_key = (
            os.environ.get(config.api_key_env) if config.api_key_env else None
        )

    def _decode_into_buffer(self, batch: list[AudioChunkPayload]) -> None:
        """
        Decode each audio chunk and append it to the window buffer, tracking the
        originating chunk ids.

        Raises:
            TranscriptionClientError if a chunk fails to decode or the client
                sends audio faster than the window can hold.
        """
        for chunk in batch:
            try:
                samples = self._decoder.decode(chunk.audio_bytes)
            except ValueError as e:
                raise TranscriptionClientError(str(e)) from e

            extra = self._buffer.append(samples)
            self._counters.inc(
                TranscriptionJobCounter.AUDIO_SECONDS_DECODED,
                len(samples) / self._config.sample_rate,
            )
            if len(extra) > 0:
                self._counters.inc(TranscriptionJobCounter.AUDIO_TOO_FAST)
                raise TranscriptionClientError("Client sent audio too quickly.")
            self._window_chunk_ids.append(chunk.chunk_id)

    def _transcribe(self, log: Logger, audio: np.ndarray) -> str:
        """
        Encode `audio` as a 16-bit WAV and POST it to Lumen, returning the text.

        Raises:
            TranscriptionClientError on client-caused failures (missing/rejected
                key). Any other upstream failure raises a server-side error.
        """
        if not self._api_key:
            raise TranscriptionClientError(
                "Upstream API key not configured "
                f"(env var '{self._config.api_key_env}' is unset)."
            )

        wav = io.BytesIO()
        sf.write(
            wav, audio, self._config.sample_rate, format="WAV", subtype="PCM_16"
        )
        wav.seek(0)

        data = {"model": self._config.model}
        if self._config.language:
            data["language"] = self._config.language
        if self._config.prompt:
            data["prompt"] = self._config.prompt

        url = self._config.base_url.rstrip("/") + self._config.request_path
        try:
            resp = requests.post(
                url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                files={"file": ("audio.wav", wav, "audio/wav")},
                data=data,
                timeout=self._config.timeout_sec,
            )
        except requests.RequestException as e:
            raise RuntimeError(
                f"Lumen transcription request failed: {e}"
            ) from e

        if resp.status_code in (401, 403):
            raise TranscriptionClientError("Upstream rejected API key")
        if not resp.ok:
            raise RuntimeError(
                f"Lumen returned {resp.status_code}: {resp.text[:200]}"
            )

        try:
            text = resp.json().get("text", "")
        except ValueError as e:
            raise RuntimeError(
                f"Lumen returned non-JSON response: {resp.text[:200]}"
            ) from e

        log.debug(f"Lumen transcript ({len(audio)} samples): {text!r}")
        return text

    def process_batch(
        self, log: Logger, contexts: tuple, batch: list[AudioChunkPayload]
    ) -> TranscriptionResult:
        self._decode_into_buffer(batch)

        audio = np.asarray(self._buffer.get())
        if audio.size == 0:
            return TranscriptionResult()

        text = self._transcribe(log, audio)

        window_ids = list(self._window_chunk_ids)

        # Window full -> commit as final and reset for the next window. Emitting
        # an empty in_progress clears the client's running in-progress line so
        # the committed text is not duplicated.
        if len(self._buffer) >= self._max_buffer_samples:
            self._buffer.purge(len(self._buffer))
            self._window_chunk_ids = []
            return TranscriptionResult(
                final=TranscriptionSequence(text=[text]),
                in_progress=TranscriptionSequence(text=[]),
                final_chunk_ids=window_ids,
            )

        # Still filling the window -> surface the running hypothesis.
        return TranscriptionResult(
            in_progress=TranscriptionSequence(text=[text]),
            in_progress_chunk_ids=window_ids,
        )

    def drain_counters(self) -> dict[str, float]:
        return self._counters.drain()

    def update_config(self, log: Logger, contexts: tuple, config: None) -> None:
        raise TranscriptionClientError("On the fly config update not supported")
