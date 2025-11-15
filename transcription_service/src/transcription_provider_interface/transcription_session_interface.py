"""
Defines TranscriptionSessionInterface API for transcription providers
"""

from abc import ABC, abstractmethod

from src.shared.utils.event_emitter import Event, EventEmitter

from .transcription_client_error import TranscriptionClientError
from .transcription_result import TranscriptionResult


class TranscriptionSessionInterface(ABC, EventEmitter):
    """
    Defines interface for providing transcriptions for a single transcription session

    Implementations must define handle_audio_chunk
    Implementations can override start_session to send transcription when session begins
    Implementations can override end_session if resources need to be cleaned up

    When transcriptions are ready, implementations should emit a TranscriptionResultEvent
    """

    TranscriptionResultEvent = Event[TranscriptionResult](
        "TRANSCRIPTION_RESULT"
    )
    TranscriptionErrorEvent = Event[TranscriptionClientError | Exception](
        "TRANSCRIPTION_ERROR"
    )

    def start_session(self):
        """
        Called after a transcription session is created and event handlers are registered
        """

    @abstractmethod
    def handle_audio_chunk(self, chunk: bytes):
        """
        Called when when an audio chunk arrives from audio stream
        Note: chunk can be any length and format

        Args:
            chunk   - Chunk of audio to handle

        Raises:
            TranscriptionClientError if error is caused by client
                (e.g. misconfiguration, invalid audio, etc.)
            Any other Exception if error is server-side
        """

    def end_session(self):
        """
        Called when a transcription session ends to cleanup resources
        """
        self.remove_all_listeners()
