"""
Equivalence and speed harness for VAD implementations, against the real model.

The unit tests fake the Silero model, because CI should not download weights or
depend on a model's exact probabilities. This script is the other half: it runs
the real model over real audio and answers the two questions the unit tests
cannot.

    1. Does the implementation under test return the same speech ranges as the
       full-buffer rescan it replaces?
    2. How long does a job period actually take?

It simulates the job's streaming loop: audio arrives in `--period-ms` chunks
into a rolling buffer capped at `--buffer-sec`, and VAD runs once per period.

Usage (inside the transcription-service image, which has the deps):

    docker run --rm \\
      -v "$PWD/test_audio_files/speech/harvard_16k_mono.wav:/tmp/a.wav:ro" \\
      -v "$PWD/transcription_service/src:/app/src:ro" \\
      -v "$PWD/transcription_service/scripts:/app/scripts:ro" \\
      --entrypoint /app/.venv/bin/python \\
      scribear/transcription-service-cpu:dev /app/scripts/vad_bench.py /tmp/a.wav

This is also the gate harness for the batched-window experiment described in
PLAN-Batched-VAD.md: point `--impl` at a new implementation and the same two
questions get answered in the same terms.
"""

import argparse
import statistics
import sys
import time

import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, "/app")

from src.shared.utils.silence_filter import (  # noqa: E402
    IncrementalVadStream,
    SilenceFiltering,
)

SAMPLE_RATE = 16000


def load_model():
    model, utils = torch.hub.load(
        repo_or_dir="snakers4/silero-vad",
        model="silero_vad",
        force_reload=False,
        trust_repo=True,
    )
    torch.set_num_threads(1)  # matches SileroVadContext.create
    return model, utils[0]


def run_session(audio, period_ms, buffer_sec, model, get_speech_timestamps):
    """
    Replays the job's loop, running both implementations on each period.

    Returns per-period (baseline_ranges, incremental_ranges, baseline_ms,
    incremental_ms) plus the purge schedule that was applied.
    """
    period_samples = int(SAMPLE_RATE * period_ms / 1000)
    max_buffer = int(SAMPLE_RATE * buffer_sec)

    stream = IncrementalVadStream(model, get_speech_timestamps, SAMPLE_RATE)
    buffer = np.empty(0, dtype=np.float32)
    buffer_start = 0
    rows = []

    for position in range(0, len(audio) - period_samples + 1, period_samples):
        buffer = np.concatenate([buffer, audio[position : position + period_samples]])

        # The job purges the oldest audio once the buffer is over budget.
        if len(buffer) > max_buffer:
            purge = len(buffer) - max_buffer
            buffer = buffer[purge:]
            buffer_start += purge

        started = time.perf_counter()
        baseline = SilenceFiltering(
            buffer, SAMPLE_RATE, model, get_speech_timestamps, threshold=0.5
        ).voice_position_detection()
        baseline_ms = (time.perf_counter() - started) * 1000

        started = time.perf_counter()
        incremental = stream.detect_speech_ranges(
            buffer, buffer_start_sample=buffer_start, threshold=0.5
        )
        incremental_ms = (time.perf_counter() - started) * 1000

        rows.append(
            (
                baseline,
                incremental,
                baseline_ms,
                incremental_ms,
                buffer_start,
                len(buffer),
            )
        )

    return rows


def clip_ranges(ranges, limit):
    """
    Clips ranges to the region both implementations actually scored.

    The full-buffer rescan zero-pads a trailing partial window and can report
    speech inside it; the incremental stream deliberately leaves that window
    for the next period, when its samples exist. Comparing outside the scored
    region measures that difference in policy, not a difference in detection.
    """
    clipped = []
    for start, end in ranges:
        start = min(start, limit)
        end = min(end, limit)
        if end > start:
            clipped.append((start, end))
    return clipped


def summarize(rows, label):
    baseline_ms = [row[2] for row in rows]
    incremental_ms = [row[3] for row in rows]
    identical = sum(1 for row in rows if row[0] == row[1])
    cold = [row for row in rows if row[4] == 0]
    cold_identical = sum(1 for row in cold if row[0] == row[1])

    # The comparison that matters: same detection over the region both scored.
    scored_equal = 0
    scored_equal_cold = 0
    divergent = []
    for index, row in enumerate(rows):
        baseline, incremental, _, _, buffer_start, buffer_length = row
        limit = (buffer_length // 512) * 512
        matches = clip_ranges(baseline, limit) == clip_ranges(incremental, limit)
        scored_equal += matches
        if buffer_start == 0:
            scored_equal_cold += matches
        if not matches:
            divergent.append((index, row, limit))

    print(f"\n=== {label} ===")
    print(f"  periods: {len(rows)} ({len(cold)} before the first purge)")
    print(
        f"  identical incl. unscored tail : {identical}/{len(rows)}"
        f"  (before any purge: {cold_identical}/{len(cold)})"
    )
    print(
        f"  identical over scored region  : {scored_equal}/{len(rows)}"
        f"  (before any purge: {scored_equal_cold}/{len(cold)})"
    )
    print(
        f"  full rescan   median {statistics.median(baseline_ms):7.2f} ms"
        f"  max {max(baseline_ms):7.2f} ms"
    )
    print(
        f"  incremental   median {statistics.median(incremental_ms):7.2f} ms"
        f"  max {max(incremental_ms):7.2f} ms"
    )
    print(
        f"  speedup (median): "
        f"{statistics.median(baseline_ms)/statistics.median(incremental_ms):.1f}x"
    )

    # Where they differ, characterise how. A different number of segments is a
    # different reading of the audio; an edge that moved by a few tens of
    # milliseconds is the warm-state effect described in incremental_vad.py.
    count_mismatches = 0
    edge_deltas_ms = []
    for _index, row, limit in divergent:
        baseline = clip_ranges(row[0], limit)
        incremental = clip_ranges(row[1], limit)
        if len(baseline) != len(incremental):
            count_mismatches += 1
            continue
        for (base_start, base_end), (inc_start, inc_end) in zip(
            baseline, incremental
        ):
            edge_deltas_ms.append(abs(base_start - inc_start) / SAMPLE_RATE * 1000)
            edge_deltas_ms.append(abs(base_end - inc_end) / SAMPLE_RATE * 1000)

    print(f"  divergent periods             : {len(divergent)}")
    print(f"    with a different segment count: {count_mismatches}")
    if edge_deltas_ms:
        moved = [delta for delta in edge_deltas_ms if delta > 0]
        print(
            f"    edges moved: {len(moved)}/{len(edge_deltas_ms)}"
            f" | median {statistics.median(moved):.1f} ms"
            f" | max {max(moved):.1f} ms"
        )
    return scored_equal == len(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", help="16kHz mono wav")
    parser.add_argument("--period-ms", type=int, default=500)
    parser.add_argument("--buffer-sec", type=float, default=30.0)
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="tile the audio to simulate a longer session",
    )
    args = parser.parse_args()

    audio, sample_rate = sf.read(args.audio, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sample_rate != SAMPLE_RATE:
        raise SystemExit(f"expected {SAMPLE_RATE}Hz audio, got {sample_rate}")
    if args.repeat > 1:
        audio = np.tile(audio, args.repeat)

    print(
        f"audio {len(audio)/SAMPLE_RATE:.1f}s | period {args.period_ms}ms |"
        f" buffer cap {args.buffer_sec}s"
    )

    model, get_speech_timestamps = load_model()
    rows = run_session(
        audio, args.period_ms, args.buffer_sec, model, get_speech_timestamps
    )
    summarize(rows, f"period={args.period_ms}ms buffer={args.buffer_sec}s")


if __name__ == "__main__":
    main()
