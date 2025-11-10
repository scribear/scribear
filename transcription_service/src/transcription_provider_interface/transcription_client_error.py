"""
Defines Error classes used by TranscriptionProviders
"""


class TranscriptionClientError(Exception):
    """
    Represents an error that occured due to client error
        e.g. Invalid config, bad audio format, etc.
    """

    def __init__(self, message: str, *args: object):
        """
        Args:
            message     - Client facing error message about error
        """
        super().__init__(message, *args)
        self.message = message
