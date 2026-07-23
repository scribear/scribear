"""Batch transcription test against Lumen's Granite Speech model.

Default mode is **Speaker-Attributed ASR (SAA)** -- the model card's "Task 2":
transcription with `[Speaker N]:` labels -- run over the bundled multi-speaker
Apollo 11 clip. Pass `--plain` for a plain transcript, or a file path to use
different audio.

    python test_batch.py                      # SAA on the multi-speaker clip
    python test_batch.py --plain              # plain transcript
    python test_batch.py path/to/audio.wav    # SAA on your own audio

CAVEAT (see README): Lumen's hosted `/v1/audio/transcriptions` does not
currently honor the SAA prompt -- it returns a plain transcript with no
`[Speaker N]:` tags. This script implements the card's approach faithfully and
reports honestly when no tags come back.
"""

from __future__ import annotations

import argparse
import re
import time

from lumen_client import transcribe

# Multi-speaker by default -- speaker attribution only makes sense with >1 voice.
DEFAULT_AUDIO = "../test_audio_files/speech/apollo11_dialogue_16k_mono.wav"

# Task 2: Speaker-Attributed ASR -- transcription with speaker labels (from the
# Granite model card). `<|audio|>` is the card's audio placeholder token.
# This is the exact prompt from the known-working curl test:
# https://github.com/angrave/granite-speech-4.1-serve/blob/main/scripts/test_plus_speakers.sh
# It yields [Speaker N]: tags on granite-speech-4.1-serve, but Lumen's endpoint
# ignores the instruction and returns a plain transcript (see README, "Task 2").
SAA_PROMPT = (
    "<|audio|> Speaker attribution: Transcribe and denote who is speaking by "
    "adding [Speaker 1]: and [Speaker 2]: tags before speaker turns."
)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("audio", nargs="?", default=DEFAULT_AUDIO)
    ap.add_argument(
        "--plain",
        action="store_true",
        help="plain transcript instead of speaker-attributed ASR",
    )
    args = ap.parse_args()

    mode = "plain transcript" if args.plain else "speaker-attributed ASR (Task 2)"
    print(f"Audio : {args.audio}")
    print(f"Mode  : {mode}\n")

    start = time.monotonic()
    text = transcribe(args.audio, prompt=None if args.plain else SAA_PROMPT)
    elapsed = time.monotonic() - start

    if args.plain:
        print(f"--- transcript ({elapsed:.1f}s) ---")
        print(text.strip())
        return

    # Card's snippet: split on the [Speaker N]: tags and print each turn.
    print(f"--- speaker-attributed transcript ({elapsed:.1f}s) ---")
    segments = [s.strip() for s in re.split(r"(\[Speaker \d+\]:)", text) if s.strip()]
    for segment in segments:
        print(segment)

    if not re.search(r"\[Speaker \d+\]:", text):
        print(
            "\nNOTE: no [Speaker N]: tags were returned. Lumen's hosted "
            "transcription endpoint does not currently expose Granite's "
            "speaker-attribution prompt -- see README.md ('Task 2 / SAA')."
        )


if __name__ == "__main__":
    main()
