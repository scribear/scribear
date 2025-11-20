"""
Defines WorkerPool job for DebugProvider that returns number of seconds of audio received
"""

import numpy as np
from typing import Optional

from src.shared.logger import Logger
from src.shared.utils.audio_decoder import AudioDecoder, TargetFormat
from src.shared.utils.local_agree import LocalAgree, TranscriptionSegment
from src.shared.utils.np_circular_buffer import NPCircularBuffer
from src.shared.utils.worker_pool import JobInterface
from src.transcription_contexts.faster_whisper_context import WhisperModel
from src.shared.utils.silence_filter import PureSilenceDetection, SilenceFiltering
from src.transcription_provider_interface import (
    TranscriptionClientError,
    TranscriptionResult,
    TranscriptionSequence,
)

from .whisper_streaming_config import WhisperStreamingProviderConfig

SAMPLE_RATE = 16000
NUM_CHANNELS = 1


class WhisperStreamingProviderJob(
    JobInterface[tuple[WhisperModel], bytes, TranscriptionResult]
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
        self._silence_threshold = float(getattr(config, "silence_threshold", 0.01))
        self._silence_detector = PureSilenceDetection(
            sample_rate= SAMPLE_RATE,
            default_silence_threshold= self._silence_threshold,
            mix_to_mono= True
        )
        
        # Silero_VAD detector config:
        self._enable_vad = bool(getattr(config, "vad_detector", False))
        self._vad_threshold = float(getattr(config, "vad_threshold", 0.5))
        self._vad_neg_threshold: Optional[float] = getattr(config, "vad_neg_threshold", None)
        if self._vad_neg_threshold is not None:
            self._vad_neg_threshold = float(self._vad_neg_threshold)
        # Lazy-loaded VAD model + util
        self._vad_model = None
        self._get_speech_timestamps = None
    

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
            try:
                is_silent = self._silence_detector.pure_silence_detection(
                    samples, self._silence_threshold
                )
            except Exception:
                is_silent = False
            
            if not is_silent:
                extra = self._buffer.append(samples)
                # More than expected number of samples received, client sending audio to fast
                if len(extra) > 0:
                    raise TranscriptionClientError("Client sent audio too quickly.")

    def _transcribe_audio(self, whisper: WhisperModel, log: Logger):
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
        
        transcription: list = []

        if not self._enable_vad:
            ranges = [(0, buffer_samples.shape[0])]
        else:
            silence_filter = None
            try:
                silence_filter = SilenceFiltering(
                    buffer_samples,
                    SAMPLE_RATE,
                    threshold = self._vad_threshold,
                    neg_threshold= self._vad_neg_threshold
                )
                ranges = silence_filter.voice_position_detection() or []
                
                max_abs = float(np.max(np.abs(buffer_samples))) if buffer_samples.size > 0 else 0.0
                rms = float(np.sqrt(np.mean(np.square(buffer_samples), dtype=np.float64))) if buffer_samples.size > 0 else 0.0
                log.debug(f"VAD ranges={ranges} | samples={buffer_samples.shape[0]} max_abs={max_abs:.6f} rms={rms:.6f} vad_threshold={self._vad_threshold}")
                
                if not ranges:
                    log.debug("VAD detected no speech in buffer")
                    try:
                        audio_chunk = np.ascontiguousarray(buffer_samples, dtype = np.float32)
                        parts, _= whisper.transcribe(
                            audio_chunk,
                            initial_prompt=self._last_finalized,
                            word_timestamps=True,
                            vad_filter=True,
                            hallucination_silence_threshold=self._silence_threshold,
                            language="en",
                            multilingual=False,
                        )
                        offset_sec = self._buffer_offset_samples / SAMPLE_RATE
                        for part in parts:
                            if getattr(part, "words", None) is None:
                                raise RuntimeError("Expected whisper transcription to have word timestamps")
                            for word in part.words:
                                transcription.append(
                                    TranscriptionSegment(word.word, offset_sec + word.start, offset_sec + word.end)
                                )
                    except Exception as e:
                        log.warning(f"Fallback transcription failed: {e}")
            except Exception as e:
                log.warning(f"VAD detection failed: {e}, falling back to full buffer")
                ranges = [(0, buffer_samples.shape[0])]
            finally:
                if silence_filter is not None:
                    try:
                        silence_filter.destroy_vad()
                    except Exception as e:
                        log.warning(f"Failed to destroy VAD: {e}")
                        
        for start_sample, end_sample in ranges:
            start_sample = max(0, int(start_sample))
            end_sample = min(buffer_samples.shape[0], int(end_sample))
            if end_sample <= start_sample:
                continue
            audio_chunk = buffer_samples[start_sample:end_sample]
            if audio_chunk.size == 0:
                continue
            
            audio_chunk = np.ascontiguousarray(audio_chunk, dtype = np.float32)

            try:
                parts, _= whisper.transcribe(
                    audio_chunk,
                    initial_prompt=self._last_finalized,
                    word_timestamps=True,
                    vad_filter=False,
                    hallucination_silence_threshold=self._silence_threshold,
                    language="en",
                    multilingual=False,
                )

                # Compensation for buffer offset to that word timestamps are correct
                offset_sec = (self._buffer_offset_samples + start_sample) / SAMPLE_RATE

                for part in parts:
                    if getattr(part, "words", None) is None:
                        raise RuntimeError("Expected whisper transcription to have word timestamps")
                    for word in part.words:
                        transcription.append(
                            TranscriptionSegment(
                                word.word,
                                offset_sec + word.start,
                                offset_sec + word.end,
                            )
                        )
            except Exception as e:
                log.warning(f"Transcription failed for segment [{start_sample}:{end_sample}]: {e}")
                continue
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
        self, log: Logger, contexts: tuple[WhisperModel], batch: list[bytes]
    ) -> TranscriptionResult:
        (whisper_model,) = contexts

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
        segments = self._transcribe_audio(whisper_model, log)
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
