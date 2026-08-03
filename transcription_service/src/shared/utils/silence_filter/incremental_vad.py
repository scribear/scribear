"""
Defines IncrementalVadStream: per-session Silero VAD that scores each window
of audio exactly once.

WHY THIS EXISTS
---------------
`SilenceFiltering` (see silence_filter.py) re-runs Silero over the *entire*
audio buffer on every job period. WhisperStreamingProviderJob keeps a rolling
buffer of up to `max_buffer_len_sec` (30s in both shipped provider configs)
and calls VAD every `job_period_ms` (500ms in the CUDA config), so each second
of audio is scored up to 60 times. Only the newly arrived samples are new
work; everything else is a repeat of a computation whose inputs have not
changed.

Silero is a streaming model: it consumes fixed 512-sample windows and carries
an LSTM state from one window to the next. That makes the redundant work
avoidable - score each window once, keep its probability, and re-run only the
(cheap, pure-Python) segmentation over the cached probabilities.

Measured with scripts/vad_bench.py over a 100s session, 30s buffer, 500ms
period, real model, single-threaded CPU:

    full-buffer rescan (what SilenceFiltering does)   69.7 ms median per call
    incremental                                        3.5 ms median per call

Scoring drops ~60x (16 new windows per period instead of 937), but the call as
a whole is ~20x faster, because segmentation now dominates: it is a Python loop
over every cached window on every call, about 2.3ms of that 3.5ms. Making the
segmentation incremental too is the obvious next step and is worth more than
any GPU work discussed below; it is not done here because it means owning
Silero's segmentation rules rather than calling them.

The segmentation itself is deliberately not reimplemented. Silero's own
`get_speech_timestamps` is called with a stand-in model that replays cached
probabilities, so thresholding, hysteresis, `min_speech_duration_ms`,
`min_silence_duration_ms`, `speech_pad_ms` and the max-speech split rules stay
byte-for-byte Silero's, including any future upstream fix.

WHAT CHANGES ABOUT THE OUTPUT
-----------------------------
Scoring a window once instead of 60 times is not free of consequences, and the
difference is worth understanding before reading a diff in captions as a bug.

The rescan restarts Silero's LSTM at the start of the buffer every period, so a
window's probability depends on where the buffer happened to begin. This
implementation carries the state across the whole session, which is how Silero
is meant to be driven, so a window's probability no longer depends on the purge
schedule. Measured over the same 100s session:

* Before the first purge (buffer still starts at the session start, so both
  have identical history): 59/60 periods identical over the region both
  scored. The one exception is the trailing-window effect below.
* After purges: the same segments, with edges that move. Of 2496 compared
  edges, 2186 moved, median 12ms, max 220ms. 9 of 142 divergent periods
  differed in segment count, all at the buffer's leading edge, where the rescan
  starts cold and needs a few windows to trigger while this implementation
  already knows speech was in progress.

Exact parity with the rescan is not available at any price: it would require
rescoring every window after every purge, which is the cost this class exists
to remove.

One further difference is deliberate: a trailing partial window is left
unscored until its samples arrive, where the rescan zero-pads it and scores it
immediately. Padding invents silence that the audio does not contain, and the
window is scored for real one period later.

WHY NOT JUST PUT SILERO ON THE GPU
----------------------------------
Measured on an RTX 5070 Ti (Blackwell, sm_120) against the same 30s buffer,
through this same code path:

    sequential CPU  (this implementation's inner loop)    74.5 ms
    sequential CUDA (same loop, model + input on GPU)    128.1 ms

The GPU is 1.7x SLOWER, and the reason is structural rather than a tuning
problem. A 30s buffer is 937 *dependent* 512-sample steps: each window needs
the LSTM state produced by the previous one, so they cannot be issued
concurrently. Every step is a separate launch of a tiny model, and launch plus
synchronisation overhead dominates a kernel that takes microseconds of actual
compute. Per-step cost measured 0.17ms on GPU against 0.08ms on CPU.

Two further facts that close off the obvious workarounds:

* The window size is not tunable. Silero v5 accepts exactly 512 samples at
  16kHz; 256, 1024, 1536, 4000 (0.25s) and 8000 were all rejected by the
  TorchScript model. Larger windows would mean a different VAD model.
* Batching the windows of a single stream *is* fast on GPU (0.6ms for all 937,
  a 124x speedup) but is not correct: it breaks the recurrence. Measured
  against the sequential baseline, mean |delta prob| was 0.40 and 42% of window
  decisions flipped at threshold 0.5. It is a different VAD, not a faster one.

So the ordering is deliberate: this implementation removes ~60x of the scoring
work while changing nothing about how any single window is scored, which makes
it both the cheaper and the safer change. It also raises the bar that any
future GPU work has to clear - the target is no longer 70ms per call, it is
3.5ms, and roughly two thirds of that is segmentation the GPU would not touch.

Two GPU-shaped ideas remain open, and both are worth exploring only after this
one is in production:

* Cross-session batching. Batching one window step across N *different*
  sessions preserves every stream's recurrence exactly, and GPU step cost is
  nearly flat in N (0.17ms at 1 stream, 0.21ms at 256), so per-stream cost
  falls from 170us to 0.8us. It needs a shared VAD service that coalesces
  requests across jobs and holds per-session state, which is a real
  architectural change, and it only pays above roughly 4 concurrent sessions
  per host.
* Batched windows with warm-up context, which trades exactness for the 124x.
  See PLAN-Batched-VAD.md for the design, the accuracy gates it must pass, and
  the tests that would have to exist first.
"""

import logging
import math
from typing import Any, Callable

import numpy as np
import numpy.typing as npt
import torch

logger = logging.getLogger(__name__)

# Silero v5 at 16kHz consumes exactly this many samples per step. This is a
# property of the model, not a tuning knob: every other size tried (256, 1024,
# 1536, 4000, 8000) raised inside the TorchScript interpreter. Changing it
# means changing VAD model.
WINDOW_SIZE_SAMPLES = 512


class _CachedProbabilityModel:
    """
    Stands in for the Silero model inside `get_speech_timestamps`.

    `get_speech_timestamps` is a loop that turns per-window probabilities into
    speech ranges. Handing it a model that replays already-computed
    probabilities lets the real segmentation run - with all of its threshold
    hysteresis, duration filtering and padding rules - without recomputing a
    single window. It is called once per window in buffer order, which is
    exactly the order the cached probabilities are in.
    """

    def __init__(self, probabilities: list[float]):
        self._probabilities = probabilities
        self._index = 0

    def reset_states(self) -> None:
        """`get_speech_timestamps` resets before iterating; rewind instead."""
        self._index = 0

    def __call__(self, chunk: Any, sampling_rate: int) -> torch.Tensor:
        # The chunk is ignored: its probability was computed when the samples
        # first arrived. Callers rely on `.item()`, so return a tensor.
        if self._index < len(self._probabilities):
            probability = self._probabilities[self._index]
        else:
            # Only reachable if the caller iterates further than the audio
            # length we sized from the cache. Treat as silence rather than
            # raising: a VAD failure must not take the transcription with it.
            probability = 0.0
        self._index += 1
        return torch.tensor(probability)


class IncrementalVadStream:
    """
    One session's view of a shared Silero model.

    Windows are indexed against the *absolute* stream position rather than an
    offset into the current buffer, because the job's buffer is a sliding
    window: it is purged from the front as audio is finalized, and those purges
    are not multiples of the window size. Absolute indexing keeps a window's
    probability valid across purges, which is the whole point of caching it.

    The Silero model instance is shared by every job in a worker process, so
    the per-session LSTM state is saved and restored around each use. That
    round-trip is exact: a sequence scored in one pass and the same sequence
    scored in two passes with a save/restore in between produce identical
    probabilities.
    """

    def __init__(
        self,
        model: Any,
        get_speech_timestamps: Callable,
        sample_rate: int = 16000,
    ):
        self._model = model
        self._get_speech_timestamps = get_speech_timestamps
        self._sample_rate = int(sample_rate)

        # Per-session Silero state, swapped into the shared model around use.
        # None means "not started yet", which the model represents with empty
        # tensors after reset_states().
        self._state: torch.Tensor | None = None
        self._context: torch.Tensor | None = None

        # Cached probabilities for absolute windows
        # [_first_cached_window, _next_window).
        self._probabilities: list[float] = []
        self._first_cached_window = 0
        self._next_window = 0
        self._started = False

    def detect_speech_ranges(
        self,
        buffer_samples: npt.NDArray,
        buffer_start_sample: int,
        threshold: float,
        neg_threshold: float | None = None,
    ) -> list[tuple[int, int]]:
        """
        Detects speech in the job's current buffer.

        Args:
            buffer_samples      - The job's whole current audio buffer
            buffer_start_sample - Absolute stream position of buffer_samples[0],
                                  i.e. the job's _buffer_offset_samples
            threshold           - Speech probability at or above which a window
                                  starts speech
            neg_threshold       - Probability below which speech ends; defaults
                                  the way SilenceFiltering does

        Returns:
            List of (start_sample, end_sample) speech ranges, relative to the
            start of buffer_samples. Empty on any inference failure, which the
            caller already treats as "no speech".
        """
        array = _as_mono_float32(buffer_samples)
        if array is None or array.size == 0:
            return []

        try:
            self._score_new_windows(array, int(buffer_start_sample))
        except (RuntimeError, OSError, TypeError) as exc:
            # Matches SilenceFiltering's failure contract: log and report no
            # speech rather than propagating into the transcription path.
            logger.error("Silero VAD inference failed: %s", exc, exc_info=True)
            return []

        return self._segment(
            len(array), int(buffer_start_sample), threshold, neg_threshold
        )

    def _score_new_windows(
        self, array: npt.NDArray, buffer_start_sample: int
    ) -> None:
        """
        Scores every complete window that has arrived since the last call.

        A partial trailing window is deliberately left unscored: its remaining
        samples have not arrived yet, and zero-padding them - which
        `get_speech_timestamps` does for a one-shot buffer - would cache a
        probability computed from audio that does not exist. It is picked up on
        the next call, at most one window (32ms) later.
        """
        buffer_end_sample = buffer_start_sample + len(array)

        # First window whose samples are all still in the buffer.
        first_available_window = math.ceil(
            buffer_start_sample / WINDOW_SIZE_SAMPLES
        )
        # One past the last window that is complete in the buffer.
        end_window = buffer_end_sample // WINDOW_SIZE_SAMPLES

        if self._next_window < first_available_window:
            # Audio was purged before it was ever scored. Only reachable if a
            # single batch overflows the whole buffer; the normal purge paths
            # trail the scoring cursor. History is gone, so restart cold rather
            # than carry a state that no longer matches the audio.
            if self._started:
                logger.warning(
                    "VAD fell behind the buffer (window %d < %d); resyncing",
                    self._next_window,
                    first_available_window,
                )
            self._next_window = first_available_window
            self._first_cached_window = first_available_window
            self._probabilities = []
            self._state = None
            self._context = None

        if self._next_window >= end_window:
            return

        with torch.inference_mode():
            self._install_state()
            for window in range(self._next_window, end_window):
                offset = window * WINDOW_SIZE_SAMPLES - buffer_start_sample
                chunk = torch.from_numpy(
                    array[offset : offset + WINDOW_SIZE_SAMPLES]
                )
                probability = self._model(chunk, self._sample_rate)
                self._probabilities.append(float(probability.item()))
            self._save_state()

        self._next_window = end_window
        self._started = True

    def _segment(
        self,
        buffer_length: int,
        buffer_start_sample: int,
        threshold: float,
        neg_threshold: float | None,
    ) -> list[tuple[int, int]]:
        """
        Turns cached probabilities into ranges using Silero's own segmentation.
        """
        aligned_window = math.ceil(buffer_start_sample / WINDOW_SIZE_SAMPLES)
        self._prune_before(aligned_window)

        window_count = self._next_window - aligned_window
        if window_count <= 0:
            return []

        probabilities = self._probabilities[
            aligned_window - self._first_cached_window :
        ]
        scored_length = window_count * WINDOW_SIZE_SAMPLES

        # Offset of the first scored window within the buffer. Non-zero only
        # when a purge left the buffer start off a window boundary; the
        # unscored remainder is under one window (32ms), which is smaller than
        # the 30ms padding Silero already applies to every range edge.
        aligned_offset = (
            aligned_window * WINDOW_SIZE_SAMPLES - buffer_start_sample
        )

        try:
            timestamps = self._get_speech_timestamps(
                # Only the length is read: the stand-in model ignores chunk
                # contents, so an expanded view avoids materialising a second
                # copy of the buffer on every call.
                torch.zeros(1).expand(scored_length),
                _CachedProbabilityModel(probabilities),
                sampling_rate=self._sample_rate,
                threshold=threshold,
                neg_threshold=_resolve_neg_threshold(threshold, neg_threshold),
                return_seconds=False,
            )
        except (RuntimeError, OSError, TypeError) as exc:
            logger.error(
                "Silero VAD segmentation failed: %s", exc, exc_info=True
            )
            return []

        return _to_buffer_ranges(timestamps, aligned_offset, buffer_length)

    def _prune_before(self, window: int) -> None:
        """Drops probabilities for windows the buffer no longer covers."""
        if window <= self._first_cached_window:
            return
        drop = min(window - self._first_cached_window, len(self._probabilities))
        self._probabilities = self._probabilities[drop:]
        self._first_cached_window += drop

    def _install_state(self) -> None:
        """
        Swaps this session's state into the shared model.

        Silero exposes its streaming state only as these attributes on the
        TorchScript module - there is no public setter, and reset_states()
        takes no arguments - so writing them is the only way several sessions
        can share one model. Verified exact: a sequence scored in one pass and
        the same sequence scored in two passes with a save/restore in between
        produce identical probabilities.
        """
        # pylint: disable=protected-access
        self._model.reset_states()
        if self._state is not None and self._context is not None:
            self._model._state = self._state
            self._model._context = self._context
            self._model._last_sr = self._sample_rate
            self._model._last_batch_size = 1

    def _save_state(self) -> None:
        """Takes this session's state back out of the shared model."""
        state = getattr(self._model, "_state", None)
        context = getattr(self._model, "_context", None)
        self._state = state.clone() if torch.is_tensor(state) else None
        self._context = context.clone() if torch.is_tensor(context) else None


def _resolve_neg_threshold(
    threshold: float, neg_threshold: float | None
) -> float:
    """Mirrors SilenceFiltering's hysteresis default."""
    neg = neg_threshold
    if neg is None:
        neg = max(0.01, threshold - 0.15)
    return min(neg, threshold - 0.001)


def _to_buffer_ranges(
    timestamps: list[dict] | None, aligned_offset: int, buffer_length: int
) -> list[tuple[int, int]]:
    """Shifts Silero's sample indices back into buffer coordinates."""
    ranges: list[tuple[int, int]] = []
    for timestamp in timestamps or []:
        start = int(timestamp.get("start", 0)) + aligned_offset
        end = int(timestamp.get("end", 0)) + aligned_offset
        start = max(0, min(start, buffer_length))
        end = max(0, min(end, buffer_length))
        if end > start:
            ranges.append((start, end))
    return ranges


def _as_mono_float32(audio_array: npt.NDArray | None) -> npt.NDArray | None:
    """Mirrors SilenceFiltering's input handling."""
    if audio_array is None:
        return None
    array = np.asarray(audio_array)
    if array.ndim > 1:
        array = array.mean(axis=1)
    if array.size == 0:
        return np.empty(0, dtype=np.float32)
    return np.ascontiguousarray(array, dtype=np.float32)
