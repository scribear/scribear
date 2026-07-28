"""
Defines WorkerPool job for DebugProvider that returns number of seconds of audio received
"""

import numpy as np

from src.shared.logger import Logger
from src.shared.utils.audio_decoder import AudioDecoder, TargetFormat
from src.shared.utils.audio_meter import AudioMeter, dbfs
from src.shared.utils.local_agree import LocalAgree, TranscriptionSegment
from src.shared.utils.np_circular_buffer import NPCircularBuffer
from src.shared.utils.repeated_segment_detector import RepeatedSegmentDetector
from src.shared.utils.silence_filter import IncrementalVadStream
from src.shared.utils.worker_pool import JobInterface
from src.transcription_contexts.faster_whisper_context import WhisperModel
from src.transcription_contexts.silero_vad_context import SileroVadModelType
from src.transcription_provider_interface import (
    STAGE_ASR_INPUT,
    STAGE_INGRESS,
    STAGE_VAD,
    AudioChunkPayload,
    AudioStageReading,
    JobCounterCollector,
    TranscriptionClientError,
    TranscriptionJobCounter,
    TranscriptionResult,
    TranscriptionSequence,
    VadStats,
)

from .whisper_streaming_config import WhisperStreamingProviderConfig

SAMPLE_RATE = 16000
NUM_CHANNELS = 1


class WhisperStreamingProviderJob(
    JobInterface[
        tuple[WhisperModel, SileroVadModelType],
        AudioChunkPayload,
        TranscriptionResult,
        None,
    ]
):
    """
    WorkerPool job definition for WhisperStreamingProvider
    """

    def __init__(self, config: WhisperStreamingProviderConfig):
        # Per-execution counters for events that happen inside the worker
        # process and are otherwise invisible to the parent.
        self._counters = JobCounterCollector()

        self._decoder = AudioDecoder(
            SAMPLE_RATE, NUM_CHANNELS, TargetFormat.FLOAT_32
        )

        # Make buffer 2 times larger than the hard cap to make forcing
        # finalization of audio easier - this headroom is unchanged by the
        # bounded-tail split below; it exists so a single oversized batch
        # can still land before force-finalization has a chance to purge.
        self._max_buffer_samples = int(SAMPLE_RATE * config.max_buffer_len_sec)
        self._buffer = NPCircularBuffer(
            self._max_buffer_samples * 2, dtype=np.float32
        )
        self._buffer_offset_samples = 0

        # Bounded tail: force-finalize purges the buffer back down to F
        # seconds (was max_buffer_len_sec before the split); a pass hands
        # Whisper only the oldest W seconds of whatever remains. Both are
        # resolved to a concrete float by config validation
        # (`WhisperStreamingProviderConfig`), which also guarantees F >= W.
        self._force_finalize_samples = int(
            SAMPLE_RATE * config.force_finalize_len_sec
        )
        self._max_transcribe_samples = int(
            SAMPLE_RATE * config.max_transcribe_len_sec
        )

        # Latency correlation: total samples ever appended (absolute stream
        # position) and a ledger mapping each source chunk to the sample span
        # it occupies, so a transcript's end time can be resolved back to the
        # chunk ids that produced it.
        self._total_decoded_samples = 0
        self._chunk_ledger: list[dict] = []

        self._local_agree = LocalAgree(config.local_agree_dim)
        self._last_finalized = ""
        self._repeated_segment_detector = RepeatedSegmentDetector()

        # Guard thresholds over Whisper's own quality signals - see
        # TranscriptionJobCounter for what each field means and why a
        # threshold crossing is a risk signal, not an error.
        self._compression_ratio_guard_threshold = (
            config.compression_ratio_guard_threshold
        )
        self._avg_logprob_guard_threshold = config.avg_logprob_guard_threshold
        self._no_speech_prob_guard_threshold = (
            config.no_speech_prob_guard_threshold
        )

        # Pure-silence threshold, handed straight to
        # whisper.transcribe(hallucination_silence_threshold=...) below.
        self._silence_threshold = config.silence_threshold

        # Independent 10s-wall-clock audio-level meter (B2.1) - RMS/peak
        # dBFS, clipping, silence, noise floor. Deliberately its own window,
        # not self._buffer: that buffer's size and purge schedule are driven
        # by transcription progress (max_buffer_len_sec, force-finalization),
        # not wall-clock time, so it cannot answer "what does the last 10s of
        # audio look like".
        self._meter = AudioMeter(
            sample_rate=SAMPLE_RATE, silence_threshold=self._silence_threshold
        )

        # Cumulative seconds decoded into the buffer, for the asr_input stage
        # reading. Held here rather than read back from the counters because
        # drain_counters() resets what it reports (per-execution deltas, by
        # contract - the parent owns the totals), so it can never serve as the
        # running total the stage graph compares across an edge. Incremented in
        # lockstep with AUDIO_SECONDS_DECODED so the two cannot drift: this is
        # exactly the sum of every delta the counter has ever reported.
        self._decoded_audio_seconds = 0.0

        # Cumulative seconds of audio VAD passed on to Whisper, and the
        # absolute stream position that total has already been charged for.
        # The watermark is what makes the total meaningful: the buffer is
        # re-detected in full every job period, so summing this period's ranges
        # would recount speech counted last period - and a cumulative total
        # that grows faster than the audio arriving would read on the dashboard
        # as a VAD stage passing on more audio than was ever decoded.
        self._speech_audio_seconds = 0.0
        self._speech_counted_through_sample = 0

        # Silero_VAD detector config:
        self._enable_vad = config.vad_detector
        self._vad_threshold = config.vad_threshold
        self._vad_neg_threshold = config.vad_neg_threshold
        if self._vad_neg_threshold is not None:
            self._vad_neg_threshold = float(self._vad_neg_threshold)

        # Per-session VAD stream, created on first use because the shared model
        # only arrives with the contexts in process_batch. It scores each
        # 512-sample window once and caches the probability, so a job period
        # costs only the audio that arrived during it rather than a rescan of
        # the whole buffer - 3.5ms against 69.7ms measured on a 30s buffer.
        # Anchored on absolute stream position, which is why every call below
        # passes self._buffer_offset_samples: the buffer slides underneath it.
        self._vad_stream: IncrementalVadStream | None = None

        # VAD statistics (B2.2) - transient, unlike self._meter: recomputed
        # every _transcribe_audio call and read by the next _build_result,
        # the same instance-state handoff self._last_finalized already uses
        # across process_batch's several _build_result call sites. None
        # until the first _transcribe_audio call completes.
        self._vad_stats: VadStats | None = None

    def _decode_audio(self, batch: list[AudioChunkPayload], log: Logger):
        """
        Decodes audio chunks and appends to buffer, recording each chunk's
        sample span in the ledger for later latency correlation.

        Audio the buffer has no room for is **dropped and counted**, never
        rejected. `NPCircularBuffer.append` returns a non-empty tail only when
        a single call carries more than the buffer's free space, and free
        space at the start of a pass is at least `max_buffer_len_sec` as long
        as `force_finalize_len_sec` (F) does not exceed it - the buffer is
        sized at twice `max_buffer_len_sec` and force-finalization purges
        back down to F every pass, so free space is `2 * max_buffer_len_sec -
        F`. A batch is everything that arrived since the
        worker last reached this job, so its size is `client_rate x
        scheduling_gap` - and the gap is the service's own, not the client's.
        A perfectly paced client therefore overruns this the moment the
        service stalls for longer than the buffer holds, which is precisely
        what happens to every live session at once when the pool saturates.

        Raising here used to close all of them and blame them for it: any job
        exception auto-deregisters the job in `worker_process_manager`, so
        there was no "close it more accurately" - not raising is the only way
        a session survives its own service stalling. Dropping the tail costs
        the audio in that tail and nothing else; the stream resumes with the
        next chunk.

        Args:
            batch   - Batch of audio chunks to decode and append
            log     - Logger for this execution

        Raises:
            TranscriptionClientError if a chunk fails to decode
        """
        for chunk in batch:
            try:
                samples = self._decoder.decode(chunk.audio_bytes)
            except ValueError as e:
                raise TranscriptionClientError(str(e)) from e

            extra = self._buffer.append(samples)
            # Metered before the drop is subtracted: the meter answers "what
            # does the audio arriving look like", which the buffer's capacity
            # has no bearing on.
            self._meter.append(samples)

            num_dropped = len(extra)
            num_retained = len(samples) - num_dropped

            if num_dropped > 0:
                dropped_sec = num_dropped / SAMPLE_RATE
                log.warning(
                    f"Audio buffer had no room for {dropped_sec:.2f}s of "
                    f"chunk {chunk.chunk_id}; dropped it. A batch that large "
                    "means this job was not scheduled for longer than the "
                    "buffer holds."
                )
                self._counters.inc(
                    TranscriptionJobCounter.AUDIO_DROPPED_BUFFER_FULL
                )
                self._counters.inc(
                    TranscriptionJobCounter.AUDIO_DROPPED_BUFFER_FULL_SECONDS,
                    dropped_sec,
                )

            # Everything below counts *retained* samples only. These three
            # numbers are all positions on, or lengths of, the same timeline
            # the buffer holds: `_total_decoded_samples` is the absolute
            # stream position word timestamps and ledger spans resolve
            # against, and charging it for audio that never entered the buffer
            # would shift every later timestamp by the dropped duration -
            # permanently, and cumulatively across drops. `_decoded_audio_
            # seconds` is the asr_input stage reading, whose whole purpose is
            # to sit below ingress by exactly what the pipeline lost.
            if num_retained > 0:
                self._chunk_ledger.append(
                    {
                        "chunk_id": chunk.chunk_id,
                        "start_sample": self._total_decoded_samples,
                        "end_sample": self._total_decoded_samples
                        + num_retained,
                    }
                )
            self._total_decoded_samples += num_retained
            self._counters.inc(
                TranscriptionJobCounter.AUDIO_SECONDS_DECODED,
                num_retained / SAMPLE_RATE,
            )
            self._decoded_audio_seconds += num_retained / SAMPLE_RATE

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

        if self._vad_stream is None:
            self._vad_stream = vad_context.create_stream()

        ranges = self._vad_stream.detect_speech_ranges(
            buffer_samples,
            buffer_start_sample=self._buffer_offset_samples,
            threshold=self._vad_threshold,
            neg_threshold=self._vad_neg_threshold,
        )

        if not ranges:
            # DEBUG, so invisible at the default production log level - the
            # counter is the only production-visible form of this signal.
            log.debug("VAD detected no speech in buffer")
            self._counters.inc(TranscriptionJobCounter.VAD_NO_SPEECH)
            return []

        return ranges

    def _compute_vad_stats(
        self, ranges: list[tuple[int, int]], buffer_samples: np.ndarray
    ) -> VadStats:
        """
        Accumulates VAD statistics (B2.2) from the speech ranges
        `_detect_speech_ranges` already computed for this buffer - no new
        detection logic, just reduction over `ranges`/`buffer_samples`.

        Args:
            ranges          - Speech ranges from _detect_speech_ranges
            buffer_samples  - The buffer those ranges were computed over

        Returns:
            Every field but vad_enabled is None when VAD is off - the
            [(0, N)] placeholder _detect_speech_ranges returns in that case
            is not a measurement, so it is not treated as one. When VAD is
            on but found no speech (`ranges == []`), speech_active_ratio/
            segment_count/speech_to_pause_ratio are real zero-valued
            readings; mean_segment_duration_sec and snr_db stay None
            (undefined, not zero - there is no segment to average and no
            signal side to compare against noise).
        """
        if not self._enable_vad:
            return VadStats(
                vad_enabled=False,
                speech_active_ratio=None,
                segment_count=None,
                mean_segment_duration_sec=None,
                speech_to_pause_ratio=None,
                snr_db=None,
            )

        total_samples = buffer_samples.shape[0]
        speech_samples = sum(end - start for start, end in ranges)
        speech_active_ratio = speech_samples / total_samples
        segment_count = len(ranges)

        mean_segment_duration_sec = (
            sum((end - start) / SAMPLE_RATE for start, end in ranges)
            / segment_count
            if segment_count > 0
            else None
        )

        speech_to_pause_ratio = (
            speech_active_ratio / (1 - speech_active_ratio)
            if speech_active_ratio < 1.0
            else None
        )

        return VadStats(
            vad_enabled=True,
            speech_active_ratio=speech_active_ratio,
            segment_count=segment_count,
            mean_segment_duration_sec=mean_segment_duration_sec,
            speech_to_pause_ratio=speech_to_pause_ratio,
            snr_db=self._compute_snr_db(ranges, buffer_samples),
        )

    def _accumulate_speech_seconds(self, ranges: list[tuple[int, int]]) -> None:
        """
        Adds the audio in `ranges` that has not been charged yet to the running
        total the vad stage reports, reusing the ranges `_detect_speech_ranges`
        already produced rather than re-detecting anything.

        `ranges` are buffer-relative and the buffer is re-detected whole every
        job period, so they are converted to absolute stream positions and
        clipped to a watermark: only audio past the furthest point already
        counted is added. Without that, a 30s buffer re-detected six times
        would report six times the speech it contained.

        A range whose speech was retroactively extended *backwards* past the
        watermark by a later detection pass is undercounted rather than
        recounted; that is the safe direction, because the total is compared
        against upstream stages by subtraction and must never exceed them.

        Args:
            ranges  - Speech ranges over the current buffer, as returned by
                        _detect_speech_ranges. When VAD is off this is the
                        full-buffer placeholder, which is the right thing to
                        charge here even though _compute_vad_stats refuses to
                        treat it as a measurement: with no detector every
                        second in the buffer really is passed on to Whisper,
                        and this field counts seconds past this point, not the
                        detector's opinion of them.
        """
        for start, end in ranges:
            absolute_end = self._buffer_offset_samples + end
            absolute_start = max(
                self._buffer_offset_samples + start,
                self._speech_counted_through_sample,
            )
            if absolute_end > absolute_start:
                self._speech_audio_seconds += (
                    absolute_end - absolute_start
                ) / SAMPLE_RATE
                self._speech_counted_through_sample = absolute_end

    def _compute_snr_db(
        self, ranges: list[tuple[int, int]], buffer_samples: np.ndarray
    ) -> float | None:
        """
        VAD-gated SNR: mean RMS (dBFS) of samples inside `ranges` minus mean
        RMS (dBFS) of samples outside them, reusing AudioMeter's dbfs() so
        this is not a second copy of the RMS->dB math.

        Returns:
            None when either side has no samples - `ranges` covering 0% or
            100% of the buffer, where "signal vs. noise" has nothing on one
            side to compare against.
        """
        in_range_mask = np.zeros(buffer_samples.shape[0], dtype=bool)
        for start, end in ranges:
            in_range_mask[start:end] = True

        signal_samples = buffer_samples[in_range_mask]
        noise_samples = buffer_samples[~in_range_mask]
        if signal_samples.size == 0 or noise_samples.size == 0:
            return None

        signal_rms = float(
            np.sqrt(np.mean(np.square(signal_samples, dtype=np.float64)))
        )
        noise_rms = float(
            np.sqrt(np.mean(np.square(noise_samples, dtype=np.float64)))
        )
        return dbfs(signal_rms) - dbfs(noise_rms)

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
        # Silero VAD Model detection. Only the oldest W seconds
        # (`max_transcribe_len_sec`) of whatever the buffer holds, front-
        # anchored - not the newest. LocalAgree commits from the front, and
        # finalization is what releases buffer space; a back-anchored window
        # would never let the front converge and the tail would grow without
        # bound. Under sustained backlog this bounds per-pass cost at W
        # instead of the full (up to F-second) tail, at the cost of interim
        # captions running behind by roughly (tail length - W).
        buffer_samples = np.asarray(self._buffer.get())[
            : self._max_transcribe_samples
        ]
        if buffer_samples.size == 0:
            # No VAD ran this call at all - a distinct absence from "VAD ran
            # and found nothing", so the whole reading is None rather than a
            # VadStats with every field None (same "absent series is not a
            # zero" distinction AudioMeter.snapshot() already makes).
            self._vad_stats = None
            return []

        ranges = self._detect_speech_ranges(buffer_samples, vad_context, log)
        self._vad_stats = self._compute_vad_stats(ranges, buffer_samples)
        self._accumulate_speech_seconds(ranges)
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

                # Whisper's own hallucination-risk signals, discarded until
                # now. Firing is a rate signal, not a fatal error - the
                # transcript is still returned either way.
                if (
                    part.compression_ratio
                    > self._compression_ratio_guard_threshold
                ):
                    self._counters.inc(
                        TranscriptionJobCounter.COMPRESSION_RATIO_GUARD_FIRED
                    )
                if part.avg_logprob < self._avg_logprob_guard_threshold:
                    self._counters.inc(
                        TranscriptionJobCounter.AVG_LOGPROB_GUARD_FIRED
                    )
                if part.no_speech_prob > self._no_speech_prob_guard_threshold:
                    self._counters.inc(
                        TranscriptionJobCounter.NO_SPEECH_PROB_GUARD_FIRED
                    )
                if part.temperature > 0:
                    self._counters.inc(
                        TranscriptionJobCounter.TEMPERATURE_FALLBACK
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

    def _extract_chunk_ids_for_time(self, end_time_sec: float) -> list[str]:
        """
        Resolve a transcript end time (seconds from stream start) to the ids of
        the source chunks that contributed to it - every ledger record that
        starts before that point. Also prunes ledger records whose audio has
        already been purged from the buffer so the ledger stays bounded.

        Args:
            end_time_sec    - Transcript end time in seconds, or 0 if unknown

        Returns:
            Chunk ids in the order the chunks were received (earliest first).
        """
        if not end_time_sec or end_time_sec <= 0:
            return []

        current_sample_idx = int(end_time_sec * SAMPLE_RATE)
        chunk_ids = [
            record["chunk_id"]
            for record in self._chunk_ledger
            if record["start_sample"] < current_sample_idx
        ]

        self._chunk_ledger = [
            record
            for record in self._chunk_ledger
            if record["end_sample"] >= self._buffer_offset_samples
        ]

        return chunk_ids

    def _audio_stages(self) -> tuple[AudioStageReading, ...]:
        """
        The two measurement points this job can see: what its decode put in
        front of Whisper, and what Silero passed on out of that.

        Neither stage is a source - the audio was already metered on the way in
        by the stream controller - so both name what fed them and let the
        publisher derive their depth.

        Returns:
            asr_input always, since "how much audio reached the ASR buffer" is
            answerable even before the meter has a window to report on (levels
            None then, which is "no data yet", not silence). vad only when a
            detection pass actually ran this batch: with self._vad_stats None
            the stage would carry no detector reading at all, and its
            cumulative seconds alone would invite a reader comparing the
            asr_input -> vad edge to charge the whole difference to a detector
            that never ran. An absent stage is the honest form of that - a
            snapshot may legitimately describe an incomplete graph, and the
            reading is at most one publish interval stale.
        """
        stages = [
            AudioStageReading(
                stage=STAGE_ASR_INPUT,
                label="ASR input (worker decode)",
                inputs=(STAGE_INGRESS,),
                levels=self._meter.snapshot(),
                vad=None,
                audio_seconds=self._decoded_audio_seconds,
            )
        ]

        if self._vad_stats is not None:
            stages.append(
                AudioStageReading(
                    stage=STAGE_VAD,
                    label="VAD (Silero)",
                    inputs=(STAGE_ASR_INPUT,),
                    levels=None,
                    vad=self._vad_stats,
                    audio_seconds=self._speech_audio_seconds,
                )
            )

        return tuple(stages)

    def _build_result(
        self,
        final: TranscriptionSequence | None,
        in_progress: TranscriptionSequence | None,
    ) -> TranscriptionResult:
        """
        Assemble a TranscriptionResult, tagging each transcript with the ids of
        the source chunks that produced it.
        """
        final_end_time = final.ends[-1] if final and final.ends else 0
        in_progress_end_time = (
            in_progress.ends[-1]
            if in_progress and in_progress.ends
            else final_end_time
        )
        return TranscriptionResult(
            in_progress=in_progress,
            final=final,
            final_chunk_ids=self._extract_chunk_ids_for_time(final_end_time),
            in_progress_chunk_ids=self._extract_chunk_ids_for_time(
                in_progress_end_time
            ),
            audio_stages=self._audio_stages(),
        )

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

    def _check_repeated_segment(self, text: str) -> None:
        """
        Runs a newly finalized segment's text past the repeated-segment
        detector and counts a hit

        Args:
            text - Text just assigned to self._last_finalized
        """
        if self._repeated_segment_detector.check(text):
            self._counters.inc(
                TranscriptionJobCounter.REPEATED_SEGMENT_DETECTED
            )

    def process_batch(
        self,
        log: Logger,
        contexts: tuple[WhisperModel, SileroVadModelType],
        batch: list[AudioChunkPayload],
    ) -> TranscriptionResult:
        whisper_model, vad_context = contexts

        self._decode_audio(batch, log)

        forced_final = None
        if len(self._buffer) > self._force_finalize_samples:
            samples_to_purge = len(self._buffer) - self._force_finalize_samples
            end_time = (
                self._buffer_offset_samples + samples_to_purge
            ) / SAMPLE_RATE

            log.info(
                f"Buffer full. Forcing finalization of audio up to: {end_time:.4f}"
            )
            self._counters.inc(TranscriptionJobCounter.BUFFER_OVERFLOW)
            self._counters.inc(
                TranscriptionJobCounter.BUFFER_OVERFLOW_SECONDS,
                samples_to_purge / SAMPLE_RATE,
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
            self._counters.inc(TranscriptionJobCounter.NO_WORDS)

            if forced_final is not None:
                self._last_finalized = "".join(forced_final.text)
                self._check_repeated_segment(self._last_finalized)
            return self._build_result(forced_final, None)

        self._local_agree.append_transcription(segments)

        final = self._local_agree.pop_finalized()
        in_progress = self._local_agree.get_in_progress()

        if final is None:
            # If nothing finalized currently, use forced_final transcription (if any)
            return self._build_result(forced_final, in_progress)

        if final is not None and final.ends:
            # Purge finalized audio from buffer
            end_time = final.ends[-1]
            end_samples = int(end_time * SAMPLE_RATE)

            samples_to_purge = end_samples - self._buffer_offset_samples
            self._buffer.purge(samples_to_purge)
            self._buffer_offset_samples = end_samples

            self._last_finalized = "".join(final.text)
            if forced_final is None:
                # Otherwise this value is about to be superseded below by the
                # combined forced_final+final text - check that one instead,
                # so a single finalization is not checked twice.
                self._check_repeated_segment(self._last_finalized)

        if forced_final is not None:
            # If forced_final transcription exists, add to beginning of finalized transcription
            self._append_sequence(forced_final, final)

            self._last_finalized = "".join(forced_final.text)
            self._check_repeated_segment(self._last_finalized)
            return self._build_result(forced_final, in_progress)

        return self._build_result(final, in_progress)

    def drain_counters(self) -> dict[str, float]:
        return self._counters.drain()

    def update_config(self, log: Logger, contexts: tuple, config: None) -> None:
        raise TranscriptionClientError("On the fly config update not supported")
