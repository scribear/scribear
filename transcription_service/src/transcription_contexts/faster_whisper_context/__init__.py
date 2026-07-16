"""
Public exports for FasterWhisperContext
"""

from typing import TYPE_CHECKING

from .faster_whisper_context import FasterWhisperContext

if TYPE_CHECKING:
    # Re-exported for typing only; importing WhisperModel at runtime would pull
    # in the heavy faster_whisper dependency.
    from .faster_whisper_context import WhisperModel

__all__ = ["FasterWhisperContext", "WhisperModel"]
