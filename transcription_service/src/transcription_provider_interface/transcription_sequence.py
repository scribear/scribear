"""
Defines TranscriptionSequence data class
"""

from dataclasses import dataclass


@dataclass
class TranscriptionSequence:
    """
    Represents a sequence of transcriptions and their timestamps

    Properties:
        text    - List of phrases or words
        starts  - List of timestamps relative to transcription session initialization
                    representing the timestamp of start of the word
        ends    - List of timestamps relative to transcription session initialization
                    representing the timestamp of end of the word

    If defined, each element of start and end array should correspond
        to an element of text array
    """

    text: list[str]
    starts: list[float] | None = None
    ends: list[float] | None = None

    def __str__(self):
        transcription = "".join(self.text)
        if self.starts is not None and self.ends is not None:
            start = min(self.starts)
            end = max(self.ends)
            return f"[{start:.4f} - {end:.4f}]: {transcription}"
        return f"[]: {transcription}"
