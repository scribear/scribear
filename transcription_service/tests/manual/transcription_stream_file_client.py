"""
Manual websocket client for streaming microphone audio to the transcription service.

Run the transcription service first:
    python3 src/index.py --dev

Then run this script from the transcription_service directory:
    python3 tests/manual/transcription_stream_file_client.py

To send a file instead:
    python3 tests/manual/transcription_stream_file_client.py --audio ../apps/node-server/shrek_16k.wav
"""

import argparse
import asyncio
import io
import json
import os
import queue
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets
from dotenv import load_dotenv


DEFAULT_TIMEOUT_SEC = 30.0
DEFAULT_CHUNK_SEC = 0.5


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _default_audio_path() -> Path:
    return _repo_root() / "apps" / "node-server" / "shrek_16k.wav"


def _load_env() -> None:
    load_dotenv(_repo_root() / "transcription_service" / ".env", override=True)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Stream microphone audio to /transcription_stream and print "
            "messages. Use --audio to send one file instead."
        )
    )
    parser.add_argument(
        "--audio",
        type=Path,
        default=None,
        help=(
            "Optional audio file to send instead of microphone input. "
            f"Example: {_default_audio_path()}."
        ),
    )
    parser.add_argument(
        "--provider",
        default="whisper",
        help="Transcription provider key to use.",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Transcription service websocket host.",
    )
    parser.add_argument(
        "--port",
        default=None,
        help="Transcription service port. Defaults to PORT from .env.",
    )
    parser.add_argument(
        "--sample-rate",
        type=int,
        default=16000,
        help="Sample rate sent in the config message.",
    )
    parser.add_argument(
        "--num-channels",
        type=int,
        default=1,
        help="Channel count sent in the config message.",
    )
    parser.add_argument(
        "--chunk-sec",
        type=float,
        default=DEFAULT_CHUNK_SEC,
        help="Microphone chunk size in seconds.",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Optional sounddevice input device name or index.",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="Print available sounddevice devices and exit.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SEC,
        help=(
            "File mode: seconds to wait for the next transcript message before "
            "exiting. Microphone mode: receive timeout used for periodic status."
        ),
    )
    return parser.parse_args()


def _print_transcript_message(message: str) -> None:
    data = json.loads(message)
    text = "".join(data.get("text", []))
    speakers = data.get("speakers")
    starts = data.get("starts")
    ends = data.get("ends")

    print(f"\n[{data['type']}]")
    print(text)
    if speakers is not None:
        print("speakers:", speakers)
    if starts is not None and ends is not None:
        print("starts:", starts)
        print("ends:", ends)


def _samples_to_wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    """
    Encode samples as WAV because the backend decoder expects audio containers.
    """
    buffer = io.BytesIO()
    sf.write(buffer, samples, sample_rate, format="WAV", subtype="FLOAT")
    return buffer.getvalue()


async def _send_audio_file(ws: websockets.ClientConnection, args) -> None:
    await ws.send(args.audio.read_bytes())
    print(f"sent {args.audio}")


async def _stream_microphone(ws: websockets.ClientConnection, args) -> None:
    try:
        import sounddevice as sd
    except ModuleNotFoundError as e:
        raise RuntimeError(
            "sounddevice is required for microphone mode. Install it with: "
            "python3 -m pip install sounddevice"
        ) from e

    audio_queue: queue.Queue[np.ndarray] = queue.Queue()

    def callback(indata, _frames, _time, status):
        if status:
            print("mic status:", status)
        audio_queue.put(indata.copy())

    async def sender() -> None:
        while True:
            samples = await asyncio.to_thread(audio_queue.get)
            await ws.send(_samples_to_wav_bytes(samples, args.sample_rate))

    blocksize = int(args.sample_rate * args.chunk_sec)
    print("streaming microphone. press Ctrl+C to stop.")

    with sd.InputStream(
        samplerate=args.sample_rate,
        channels=args.num_channels,
        dtype="float32",
        blocksize=blocksize,
        device=args.device,
        callback=callback,
    ):
        await sender()


async def _receive_messages(ws: websockets.ClientConnection, args) -> None:
    while True:
        try:
            message = await asyncio.wait_for(ws.recv(), timeout=args.timeout)
        except asyncio.TimeoutError:
            if args.audio is not None:
                print(f"\nno transcript messages for {args.timeout:.1f}s")
                break
            print(f"\nwaiting for transcript messages...")
            continue

        _print_transcript_message(message)


async def _run() -> None:
    _load_env()
    args = _parse_args()

    if args.list_devices:
        try:
            import sounddevice as sd
        except ModuleNotFoundError as e:
            raise RuntimeError(
                "sounddevice is required to list microphone devices. "
                "Install it with: python3 -m pip install sounddevice"
            ) from e
        print(sd.query_devices())
        return

    api_key = os.environ["API_KEY"]
    port = args.port or os.environ.get("PORT", "8000")
    uri = f"ws://{args.host}:{port}/transcription_stream/{args.provider}"

    async with websockets.connect(uri, max_size=None) as ws:
        await ws.send(json.dumps({"type": "auth", "api_key": api_key}))
        await ws.send(
            json.dumps(
                {
                    "type": "config",
                    "config": {
                        "sample_rate": args.sample_rate,
                        "num_channels": args.num_channels,
                    },
                }
            )
        )

        if args.audio is not None:
            await _send_audio_file(ws, args)
            await _receive_messages(ws, args)
            return

        await asyncio.gather(
            _stream_microphone(ws, args), _receive_messages(ws, args)
        )


if __name__ == "__main__":
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        print("\nstopped")
