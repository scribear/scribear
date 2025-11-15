"""
Defines TranscriptionProviderInterface API for transcription providers
"""

from abc import ABC, abstractmethod

from src.shared.logger import Logger
from src.shared.utils.worker_pool import WorkerPool

from .transcription_session_interface import TranscriptionSessionInterface


class TranscriptionProviderInterface(ABC):
    """
    Defines interface for providing transcriptions for a single transcription session

    Implementations should:
    - Define handler for begin_session() an returns TranscriptionSessionInterface implementation
    - Define handler for end_session()

    It is acceptable for this class to throw Exceptions for fatal exceptions.
    For other exceptions, a TranscriptionError or ValidationError should be used
        Only begin_session() should only throw TranscriptionError or ValidationError
        A transcription session should emit a TranscriptionErrorEvent instead of throwing exceptions
    """

    @abstractmethod
    def __init__(
        self, provider_config: object, logger: Logger, worker_pool: WorkerPool
    ):
        """
        Args:
            provider_config - Provider configuration object unique to transcription provider
            logger          - Application logger
            worker_pool     - Application worker pool to dispatch compute heavy work to
        """

    @abstractmethod
    def create_session(
        self, session_config: object, logger: Logger
    ) -> TranscriptionSessionInterface:
        """
        Called when a transcription session is requested
        start_session() should be called on session returned after event handlers are registered

        This function (and this function only) should only throw
            TranscriptionError or ValidationError exceptions.

        Note: The schema of session_config should be validated and
            TranscriptionClientError thrown if invalid.

        Args:
            session_config  - Session configuration object unique to transcription provider
            logger          - Application logger for session to use

        Returns:
            Object implementing TranscriptionSessionInterface
        """

    @abstractmethod
    def cleanup_provider(self):
        """
        Called when application exits
        Should cleanup resources used by TranscriptionProvider
        """
