"""
Defines the per-execution counters transcription jobs report to the parent
process
"""

from enum import StrEnum


class TranscriptionJobCounter(StrEnum):
    """
    Names of counters a transcription job may report for one execution

    These events happen inside the spawned worker process, so a counter
    incremented there is invisible to the FastAPI process that serves
    `/metrics/status`. Jobs accumulate them here and the worker pool carries
    them back on the result that already crosses the process boundary.

    Values are per-execution deltas, never running totals: the parent owns the
    monotonic totals, so a worker restart cannot double count.
    """

    #: Seconds of audio decoded and ingested. The RTF denominator, and the
    #: service's throughput. Reported in seconds rather than samples because
    #: the sample rate is per-provider config, and the parent should not have
    #: to know each provider's rate to interpret a counter.
    AUDIO_SECONDS_DECODED = "audio_seconds_decoded"

    #: Times the audio buffer filled and older audio was force-finalized.
    BUFFER_OVERFLOW = "buffer_overflow"

    #: Seconds of audio discarded by those force-finalizations. The count
    #: alone does not say *how much* audio was lost.
    BUFFER_OVERFLOW_SECONDS = "buffer_overflow_seconds"

    #: Times a client pushed audio faster than realtime and overran the buffer.
    AUDIO_TOO_FAST = "audio_too_fast"

    #: Executions where VAD found no speech at all in the buffer.
    VAD_NO_SPEECH = "vad_no_speech"

    #: Executions that transcribed no words from a non-empty buffer.
    NO_WORDS = "no_words"

    #: Segments where `part.compression_ratio` exceeded its guard threshold.
    #: Whisper computes this as transcript-length-vs-compressed-length; a high
    #: ratio means the text is repetitive, one of Whisper's own signals that a
    #: segment may be a hallucination rather than real speech. A hallucination
    #: risk signal, not a fatal error - the transcript is still returned.
    COMPRESSION_RATIO_GUARD_FIRED = "compression_ratio_guard_fired"

    #: Segments where `part.avg_logprob` fell below its guard threshold.
    #: Whisper's average log-probability across the segment's tokens; a low
    #: value means the model itself was not confident in what it decoded.
    #: A hallucination risk signal, not a fatal error - the transcript is
    #: still returned.
    AVG_LOGPROB_GUARD_FIRED = "avg_logprob_guard_fired"

    #: Segments where `part.no_speech_prob` exceeded its guard threshold.
    #: Whisper's own estimate that the segment contains no speech at all; a
    #: high value flags audio (silence, noise) that likely produced text
    #: anyway. A hallucination risk signal, not a fatal error - the
    #: transcript is still returned.
    NO_SPEECH_PROB_GUARD_FIRED = "no_speech_prob_guard_fired"

    #: Segments where `part.temperature > 0`. faster-whisper decodes greedily
    #: (temperature 0) by default and only retries at a higher sampling
    #: temperature when its own quality checks reject the greedy result - so
    #: this counter is the visible half of a fallback whisper already
    #: performs internally, not a new detection. A hallucination risk signal,
    #: not a fatal error.
    TEMPERATURE_FALLBACK = "temperature_fallback"

    #: Finalized segments whose text substantially overlaps the previously
    #: finalized segment (see `RepeatedSegmentDetector`). Whisper hallucination
    #: loops tend to repeat text almost verbatim across segments rather than
    #: garble a single one, which is the failure mode the guard-fired counters
    #: above cannot see. A hallucination risk signal, not a fatal error.
    REPEATED_SEGMENT_DETECTED = "repeated_segment_detected"


class JobCounterCollector:
    """
    Accumulates counters within a single job execution

    Drained by the worker after every `process_batch`, successful or not, so
    the counters leading up to a raised exception are not lost - which matters
    most for audio-too-fast, whose only signal *is* the exception.
    """

    def __init__(self):
        self._counters: dict[str, float] = {}

    def inc(self, counter: TranscriptionJobCounter, value: float = 1) -> None:
        """
        Increments a counter for the current execution

        Args:
            counter - Counter to increment
            value   - Amount to add
        """
        self._counters[counter] = self._counters.get(counter, 0) + value

    def drain(self) -> dict[str, float]:
        """
        Returns the counters accumulated since the last drain and resets them
        """
        drained = self._counters
        self._counters = {}
        return drained
