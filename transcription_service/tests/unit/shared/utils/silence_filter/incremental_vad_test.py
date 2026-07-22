"""
Unit tests for IncrementalVadStream

The Silero model is faked. What is under test is the part this repo owns: the
absolute-window cursor, the probability cache, alignment across buffer purges,
and the failure contract. Silero's own segmentation is exercised separately by
scripts/vad_bench.py, which uses the real model.
"""

# Asserting on cache and state internals is the point of several of these.
# pylint: disable=protected-access

from typing import Any

import numpy as np
import pytest
import torch

from src.shared.utils.silence_filter import (
    WINDOW_SIZE_SAMPLES,
    IncrementalVadStream,
)

SAMPLE_RATE = 16000


class FakeModel:
    """
    Scores a window by its mean absolute amplitude, so a test can build audio
    whose speech ranges it knows. Records every window it is asked to score.
    """

    def __init__(self, raises: Exception | None = None):
        self.calls: list[np.ndarray] = []
        self.reset_count = 0
        self._raises = raises
        self._state = torch.zeros(0)
        self._context = torch.zeros(0)
        self._last_sr = 0
        self._last_batch_size = 0

    def reset_states(self) -> None:
        """Silero's reset hook; counted so tests can assert it was called."""
        self.reset_count += 1
        self._state = torch.zeros(0)
        self._context = torch.zeros(0)

    def __call__(self, chunk: Any, sampling_rate: int) -> torch.Tensor:
        """Scores one window, or raises if the fake was built to fail."""
        if self._raises is not None:
            raise self._raises
        window = np.asarray(chunk)
        self.calls.append(window.copy())
        # Carry a state so save/restore has something observable to preserve.
        self._state = torch.tensor([float(len(self.calls))])
        self._context = torch.tensor(window[-64:].copy())
        return torch.tensor(float(np.abs(window).mean()))


def fake_get_speech_timestamps(
    audio, model, sampling_rate, threshold, neg_threshold, return_seconds
):
    """
    Minimal stand-in for Silero's segmenter: one window at a time, no duration
    filtering or padding, so tests assert on window boundaries exactly.
    """
    del return_seconds  # signature parity with Silero's segmenter
    model.reset_states()
    speeches = []
    speech_start: int | None = None
    for start in range(0, len(audio), WINDOW_SIZE_SAMPLES):
        probability = model(
            audio[start : start + WINDOW_SIZE_SAMPLES], sampling_rate
        ).item()
        if probability >= threshold and speech_start is None:
            speech_start = start
        elif probability < neg_threshold and speech_start is not None:
            speeches.append({"start": speech_start, "end": start})
            speech_start = None
    if speech_start is not None:
        speeches.append({"start": speech_start, "end": len(audio)})
    return speeches


def make_stream(model: FakeModel | None = None):
    """A stream over a fake model, returned with the model for assertions."""
    model = model or FakeModel()
    stream = IncrementalVadStream(
        model, fake_get_speech_timestamps, SAMPLE_RATE
    )
    return stream, model


def audio_of(windows: list[float]) -> np.ndarray:
    """One constant-amplitude 512-sample window per entry."""
    return np.concatenate(
        [
            np.full(WINDOW_SIZE_SAMPLES, amplitude, dtype=np.float32)
            for amplitude in windows
        ]
    )


class TestScoringHappensOnce:
    """The whole point: a window's probability is computed exactly once."""

    def test_repeated_call_on_unchanged_buffer_scores_nothing_new(self):
        """A second call over the same buffer scores no windows again."""
        stream, model = make_stream()
        buffer = audio_of([0.9, 0.9, 0.9])

        stream.detect_speech_ranges(buffer, 0, threshold=0.5)
        assert len(model.calls) == 3

        stream.detect_speech_ranges(buffer, 0, threshold=0.5)
        assert len(model.calls) == 3, "buffer unchanged, nothing to rescore"

    def test_growing_buffer_scores_only_the_new_windows(self):
        """Only windows that arrived since the last call are scored."""
        stream, model = make_stream()

        stream.detect_speech_ranges(audio_of([0.9] * 4), 0, threshold=0.5)
        assert len(model.calls) == 4

        stream.detect_speech_ranges(audio_of([0.9] * 7), 0, threshold=0.5)
        assert len(model.calls) == 7, "only the 3 new windows are scored"

    def test_partial_trailing_window_is_not_scored_until_complete(self):
        """An incomplete trailing window waits for its samples instead of being padded."""
        stream, model = make_stream()

        partial = np.concatenate(
            [audio_of([0.9]), np.full(100, 0.9, dtype=np.float32)]
        )
        stream.detect_speech_ranges(partial, 0, threshold=0.5)
        assert len(model.calls) == 1, "the 100-sample remainder is not padded"

        stream.detect_speech_ranges(audio_of([0.9, 0.9]), 0, threshold=0.5)
        assert len(model.calls) == 2

    def test_scored_windows_hold_the_right_samples(self):
        """Each scored window carries the audio at its own offset."""
        stream, model = make_stream()
        buffer = audio_of([0.1, 0.9])

        stream.detect_speech_ranges(buffer, 0, threshold=0.5)

        assert pytest.approx(model.calls[0].mean(), abs=1e-6) == 0.1
        assert pytest.approx(model.calls[1].mean(), abs=1e-6) == 0.9


class TestRangesMatchAFullRescan:
    """
    Incremental scoring must not change the answer. The fake model is
    stateless, so a full rescan is the exact reference.
    """

    def test_incremental_equals_one_shot_when_buffer_starts_at_zero(self):
        """Period-by-period scoring gives the same ranges as scoring it all at once."""
        pattern = [0.1, 0.9, 0.9, 0.1, 0.1, 0.9, 0.1]
        buffer = audio_of(pattern)

        incremental, _ = make_stream()
        for window_count in range(1, len(pattern) + 1):
            incremental_ranges = incremental.detect_speech_ranges(
                audio_of(pattern[:window_count]), 0, threshold=0.5
            )

        one_shot, _ = make_stream()
        one_shot_ranges = one_shot.detect_speech_ranges(
            buffer, 0, threshold=0.5
        )

        assert incremental_ranges == one_shot_ranges
        assert incremental_ranges == [
            (WINDOW_SIZE_SAMPLES, 3 * WINDOW_SIZE_SAMPLES),
            (5 * WINDOW_SIZE_SAMPLES, 6 * WINDOW_SIZE_SAMPLES),
        ]


class TestBufferPurges:
    """
    The job purges finalized audio off the front of its buffer, so the same
    audio moves to a lower buffer index over time while its absolute stream
    position never changes.
    """

    def test_window_aligned_purge_keeps_cached_probabilities(self):
        """A purge on a window boundary does not invalidate cached probabilities."""
        stream, model = make_stream()
        stream.detect_speech_ranges(
            audio_of([0.1, 0.9, 0.9, 0.1]), 0, threshold=0.5
        )
        assert len(model.calls) == 4

        # Two windows finalized and purged; one new window arrives.
        ranges = stream.detect_speech_ranges(
            audio_of([0.9, 0.1, 0.9]), 2 * WINDOW_SIZE_SAMPLES, threshold=0.5
        )

        assert len(model.calls) == 5, "only the newly arrived window is scored"
        assert ranges == [
            (0, WINDOW_SIZE_SAMPLES),
            (2 * WINDOW_SIZE_SAMPLES, 3 * WINDOW_SIZE_SAMPLES),
        ]

    def test_unaligned_purge_offsets_ranges_by_the_alignment_remainder(self):
        """
        Purges are driven by transcript timings, so the buffer rarely starts on
        a window boundary. Ranges must come back in buffer coordinates.
        """
        stream, _ = make_stream()
        # Only windows 0 and 1 are scored here. A given absolute position is
        # scored once and never revisited, so the audio the second call places
        # at windows 2+ must be audio this call had not yet seen - which is
        # what an append-only buffer guarantees.
        stream.detect_speech_ranges(audio_of([0.1] * 2), 0, threshold=0.5)

        remainder = 200
        buffer_start = 2 * WINDOW_SIZE_SAMPLES - remainder
        buffer = np.concatenate(
            [
                np.full(remainder, 0.1, dtype=np.float32),
                audio_of([0.9, 0.1, 0.9]),
            ]
        )

        ranges = stream.detect_speech_ranges(
            buffer, buffer_start, threshold=0.5
        )

        # The first scored window starts `remainder` samples into the buffer.
        assert ranges == [
            (remainder, remainder + WINDOW_SIZE_SAMPLES),
            (
                remainder + 2 * WINDOW_SIZE_SAMPLES,
                remainder + 3 * WINDOW_SIZE_SAMPLES,
            ),
        ]

    def test_probabilities_for_purged_audio_are_dropped(self):
        """The cache does not grow without bound as the buffer slides."""
        stream, _ = make_stream()
        stream.detect_speech_ranges(audio_of([0.9] * 10), 0, threshold=0.5)

        stream.detect_speech_ranges(
            audio_of([0.9] * 2), 8 * WINDOW_SIZE_SAMPLES, threshold=0.5
        )

        assert len(stream._probabilities) == 2, "cache follows the buffer"

    def test_resync_when_audio_is_purged_before_it_is_scored(self):
        """
        Only reachable if a batch overflows the entire buffer. The stream must
        restart cleanly rather than index behind the buffer start.
        """
        stream, model = make_stream()
        stream.detect_speech_ranges(audio_of([0.9, 0.9]), 0, threshold=0.5)
        assert len(model.calls) == 2

        # Jump far past the scored cursor: windows 2..99 never arrived.
        ranges = stream.detect_speech_ranges(
            audio_of([0.9, 0.1]), 100 * WINDOW_SIZE_SAMPLES, threshold=0.5
        )

        assert len(model.calls) == 4
        assert ranges == [(0, WINDOW_SIZE_SAMPLES)]


class TestStateHandling:
    """
    The model is shared by every job in the worker, so each stream carries its
    own Silero state in and out around use.
    """

    def test_state_is_restored_into_the_model_on_the_next_call(self):
        """A stream's Silero state survives another stream using the model."""
        stream, model = make_stream()

        stream.detect_speech_ranges(audio_of([0.9]), 0, threshold=0.5)
        saved = stream._state.clone()

        # Another stream uses the same model in between, clobbering its state.
        other, _ = make_stream(model)
        other.detect_speech_ranges(audio_of([0.1] * 5), 0, threshold=0.5)

        stream.detect_speech_ranges(audio_of([0.9, 0.9]), 0, threshold=0.5)

        assert torch.equal(saved, torch.tensor([1.0]))
        assert model._state is not None

    def test_two_streams_over_one_model_score_independently(self):
        """Two sessions sharing a model keep separate caches and states."""
        model = FakeModel()
        first = IncrementalVadStream(
            model, fake_get_speech_timestamps, SAMPLE_RATE
        )
        second = IncrementalVadStream(
            model, fake_get_speech_timestamps, SAMPLE_RATE
        )

        first.detect_speech_ranges(audio_of([0.9, 0.9]), 0, threshold=0.5)
        second.detect_speech_ranges(audio_of([0.1]), 0, threshold=0.5)
        first_ranges = first.detect_speech_ranges(
            audio_of([0.9, 0.9, 0.1]), 0, threshold=0.5
        )

        assert first_ranges == [(0, 2 * WINDOW_SIZE_SAMPLES)]
        assert len(model.calls) == 4, "no stream rescores another's windows"


class TestFailureContract:
    """
    A VAD failure degrades to "no speech" rather than taking the transcription
    down with it - the same contract SilenceFiltering has.
    """

    def test_inference_failure_returns_no_ranges(self):
        """A raising model degrades to no speech rather than propagating."""
        stream, _ = make_stream(FakeModel(raises=RuntimeError("cuda boom")))

        assert not stream.detect_speech_ranges(
            audio_of([0.9]), 0, threshold=0.5
        )

    def test_empty_buffer_returns_no_ranges(self):
        """An empty buffer is answered without invoking the model."""
        stream, model = make_stream()

        assert not stream.detect_speech_ranges(
            np.empty(0, dtype=np.float32), 0, threshold=0.5
        )
        assert model.calls == []

    def test_buffer_shorter_than_one_window_returns_no_ranges(self):
        """A buffer below one window has nothing complete to score."""
        stream, model = make_stream()

        assert not stream.detect_speech_ranges(
            np.full(100, 0.9, dtype=np.float32), 0, threshold=0.5
        )
        assert model.calls == []
