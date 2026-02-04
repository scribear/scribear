"""
Defines WorkerPool job for DebugProvider that returns number of seconds of audio received
"""

import numpy as np

from src.shared.logger import Logger
from src.shared.utils.audio_decoder import AudioDecoder, TargetFormat
from src.shared.utils.local_agree import LocalAgree, TranscriptionSegment
from src.shared.utils.np_circular_buffer import NPCircularBuffer
from src.shared.utils.silence_filter import (
    SilenceFiltering,
    RMSSilenceDetection
)
from src.shared.utils.worker_pool import JobInterface
from src.transcription_contexts.faster_whisper_context import WhisperModel
from src.transcription_contexts.silero_vad_context import SileroVadModelType
from src.transcription_provider_interface import (
    TranscriptionClientError,
    TranscriptionResult,
    TranscriptionSequence,
)

from .whisper_streaming_config import WhisperStreamingProviderConfig

SAMPLE_RATE = 16000
NUM_CHANNELS = 1


class WhisperStreamingProviderJob(
    JobInterface[
        tuple[WhisperModel, SileroVadModelType], bytes, TranscriptionResult
    ]
):
    """
    WorkerPool job definition for WhisperStreamingProvider
    """

    def __init__(self, config: WhisperStreamingProviderConfig):
        self._decoder = AudioDecoder(
            SAMPLE_RATE, NUM_CHANNELS, TargetFormat.FLOAT_32
        )

        # Make buffer 2 times larger than maximum to make forcing finalization of audio easier
        self._max_buffer_samples = int(SAMPLE_RATE * config.max_buffer_len_sec)
        self._buffer = NPCircularBuffer(
            self._max_buffer_samples * 2, dtype=np.float32
        )
        self._buffer_offset_samples = 0

        self._local_agree = LocalAgree(config.local_agree_dim)
        self._last_finalized = ""

        # Pure_silence detector:
        self._silence_threshold = config.silence_threshold
        self._silence_detector = RMSSilenceDetection(
            sample_rate=SAMPLE_RATE,
            default_silence_threshold=self._silence_threshold,
            mix_to_mono=True,
        )

        # Silero_VAD detector config:
        self._enable_vad = config.vad_detector
        self._vad_threshold = config.vad_threshold
        self._vad_neg_threshold = config.vad_neg_threshold
        if self._vad_neg_threshold is not None:
            self._vad_neg_threshold = float(self._vad_neg_threshold)

    def _decode_audio(self, batch: list[bytes]):
        """
        Decodes audio chunks and appends to buffer
        Pure_silence detection before appends audio to buffer

        Args:
            batch   - Batch of audio chunks to decode and append

        Raises:
            TranscriptionClientError if chunks fail to decode or client sends audio too fast
        """
        for chunk in batch:
            try:
                samples = self._decoder.decode(chunk)
            except ValueError as e:
                raise TranscriptionClientError(str(e)) from e

            # Pure_silence detection:
            is_silent = self._silence_detector.detect(
                samples, self._silence_threshold
            )

            if not is_silent:
                extra = self._buffer.append(samples)
                # More than expected number of samples received, client sending audio to fast
                if len(extra) > 0:
                    raise TranscriptionClientError(
                        "Client sent audio too quickly."
                    )

    def _detect_speech_ranges(
        self,
        buffer_samples: np.ndarray,
        vad_context: SileroVadModelType,
        log: Logger,
    ) -> list[tuple[int, int]]:
        """
        Helper method to detect speech ranges using Silero VAD or return full range.
        """
        if not self._enable_vad:
            return [(0, buffer_samples.shape[0])]

        ranges = vad_context.detect_speech_ranges(
            buffer_samples,
            threshold = self._vad_threshold,
            neg_threshold=self._vad_neg_threshold
        )

        if not ranges:
            log.debug("VAD detected no speech in buffer")
            return []

        return ranges

    def _transcribe_audio(
        self,
        whisper: WhisperModel,
        vad_context: SileroVadModelType,
        log: Logger,
    ):
        """
        Pass the audio buffer into Silero VAD Model to separate audio segments
        Transcribes audio segments in audio buffer into a list of TranscriptionSegments

        Args:
            whisper     - Whisper model context instance provided by WorkerPool

        Returns:
            List of TranscriptionSegments
        """
        # Silero VAD Model detection
        buffer_samples = np.asarray(self._buffer.get())
        if buffer_samples.size == 0:
            return []

        ranges = self._detect_speech_ranges(buffer_samples, vad_context, log)
        transcription: list = []

        for start_sample, end_sample in ranges:
            start_sample = max(0, int(start_sample))
            end_sample = min(buffer_samples.shape[0], int(end_sample))
            if end_sample <= start_sample:
                continue
            audio_chunk = buffer_samples[start_sample:end_sample]
            if audio_chunk.size == 0:
                continue
            audio_chunk = np.ascontiguousarray(audio_chunk, dtype=np.float32)

            parts, _ = whisper.transcribe(
                audio_chunk,
                initial_prompt=self._last_finalized,
                word_timestamps=True,
                vad_filter=False,
                hallucination_silence_threshold=self._silence_threshold,
                language="en",
                multilingual=False,
            )

            # Compensation for buffer offset to that word timestamps are correct
            offset_sec = (
                self._buffer_offset_samples + start_sample
            ) / SAMPLE_RATE

            for part in parts:
                if getattr(part, "words", None) is None:
                    raise RuntimeError(
                        "Expected whisper transcription to have word timestamps"
                    )
                for word in part.words:
                    transcription.append(
                        TranscriptionSegment(
                            word.word,
                            offset_sec + word.start,
                            offset_sec + word.end,
                        )
                    )
        return transcription

    def _append_sequence(
        self, a: TranscriptionSequence, b: TranscriptionSequence
    ):
        """
        Appends one transcription sequence with another

        Args:
            a       - Base TranscriptionSequence to append onto
            b       - TranscriptionSequence that should be appended to end of a
        """
        a.text.extend(b.text)
        if a.starts is not None and b.starts is not None:
            a.starts.extend(b.starts)
        if a.ends is not None and b.ends is not None:
            a.ends.extend(b.ends)

    def process_batch(
        self,
        log: Logger,
        contexts: tuple[WhisperModel, SileroVadModelType],
        batch: list[bytes],
    ) -> TranscriptionResult:
        whisper_model, vad_context = contexts

        self._decode_audio(batch)

        forced_final = None
        if len(self._buffer) > self._max_buffer_samples:
            samples_to_purge = len(self._buffer) - self._max_buffer_samples
            end_time = (
                self._buffer_offset_samples + samples_to_purge
            ) / SAMPLE_RATE

            log.info(
                f"Buffer full. Forcing finalization of audio up to: {end_time:.4f}"
            )
            forced_final = self._local_agree.force_finalized(end_time)

            # Remove finalized audio from buffer
            self._buffer.purge(samples_to_purge)
            self._buffer_offset_samples += samples_to_purge

        # Transcribe the audio currently in the buffer
        log.debug("Last finalized: " + self._last_finalized)
        segments = self._transcribe_audio(whisper_model, vad_context, log)
        if len(segments) == 0:
            log.info("No words transcribed in buffer.")

            if forced_final is not None:
                self._last_finalized = "".join(forced_final.text)
            return TranscriptionResult(final=forced_final)

        self._local_agree.append_transcription(segments)

        final = self._local_agree.pop_finalized()
        in_progress = self._local_agree.get_in_progress()

        if final is None:
            # If nothing finalized currently, use forced_final transcription (if any)
            return TranscriptionResult(
                in_progress=in_progress, final=forced_final
            )

        if final is not None and final.ends:
            # Purge finalized audio from buffer
            end_time = final.ends[-1]
            end_samples = int(end_time * SAMPLE_RATE)

            samples_to_purge = end_samples - self._buffer_offset_samples
            self._buffer.purge(samples_to_purge)
            self._buffer_offset_samples = end_samples

            self._last_finalized = "".join(final.text)

        if forced_final is not None:
            # If forced_final transcription exists, add to beginning of finalized transcription
            self._append_sequence(forced_final, final)

            self._last_finalized = "".join(forced_final.text)
            return TranscriptionResult(
                in_progress=in_progress, final=forced_final
            )

        return TranscriptionResult(in_progress=in_progress, final=final)
