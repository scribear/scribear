"""Realtime-caption (pseudo-streaming) test against Lumen Granite Speech.

WHY PSEUDO-STREAMING:
    Lumen's `/v1/audio/transcriptions` route is *not* a true streaming
    endpoint. Passing `stream=true` is accepted but ignored -- the server
    responds with a single `application/json` body (Content-Type is
    `application/json`, not `text/event-stream`), i.e. one transcript for
    the whole upload. There is no incremental SSE/token delta.

    So for live captions the pattern (the same one the repo wiki calls
    "Recipe B - remote OpenAI-like server") is a sliding/growing WINDOW:
    accumulate mic audio into a buffer and, every `period` seconds, POST the
    current buffer and surface the returned text as an `in_progress` caption.
    Once a chunk is stable you'd finalize it and purge older audio.

    This script simulates that live loop by walking the bundled file in
    growing windows and re-transcribing each one, printing per-request
    latency (which the ScribeAR latency-metrics work cares about).

Usage:
    python test_streaming.py [path/to/audio.wav] [--period SECONDS]
"""

from __future__ import annotations

import argparse
import io
import time
import wave

from lumen_client import get_client

DEFAULT_AUDIO = "../test_audio_files/speech/harvard_16k_mono.wav"


def read_wav(path: str) -> tuple[wave._wave_params, bytes]:
    with wave.open(path, "rb") as w:
        params = w.getparams()
        frames = w.readframes(w.getnframes())
    return params, frames


def wav_bytes(params: wave._wave_params, frames: bytes) -> io.BytesIO:
    """Wrap raw PCM frames back into an in-memory .wav file object."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(params.nchannels)
        w.setsampwidth(params.sampwidth)
        w.setframerate(params.framerate)
        w.writeframes(frames)
    buf.seek(0)
    buf.name = "chunk.wav"  # openai SDK uses this to set the upload filename
    return buf


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", nargs="?", default=DEFAULT_AUDIO)
    ap.add_argument(
        "--period",
        type=float,
        default=3.0,
        help="seconds of audio to add to the window each step (default 3.0)",
    )
    args = ap.parse_args()

    client, model = get_client()
    params, frames = read_wav(args.audio)
    rate = params.framerate
    bytes_per_sec = rate * params.sampwidth * params.nchannels
    total_sec = len(frames) / bytes_per_sec

    print(f"Model  : {model}")
    print(f"Audio  : {args.audio}  ({total_sec:.1f}s, {rate} Hz, "
          f"{params.nchannels}ch, {params.sampwidth * 8}-bit)")
    print(f"Window : growing, +{args.period:.1f}s per step\n")
    print("Simulating live captions (each line = current buffer transcript):\n")

    step = 0
    end_sec = args.period
    while True:
        step += 1
        end_byte = min(len(frames), int(end_sec * bytes_per_sec))
        window = frames[:end_byte]

        start = time.monotonic()
        resp = client.audio.transcriptions.create(
            model=model,
            file=wav_bytes(params, window),
            response_format="json",
        )
        latency = time.monotonic() - start
        audio_len = end_byte / bytes_per_sec

        text = resp.text.strip()
        print(f"[{audio_len:5.1f}s audio | {latency:4.1f}s req] {text}")

        if end_byte >= len(frames):
            break
        end_sec += args.period

    print(f"\nDone ({step} requests).")


if __name__ == "__main__":
    main()
