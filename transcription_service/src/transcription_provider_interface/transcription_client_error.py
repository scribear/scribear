"""
Defines Error classes used by TranscriptionProviders
"""

# WebSocket close reason a capacity refusal is sent with, stated once here
# rather than at the point of the close. The node server keys "refused" apart
# from "crashed" off this exact string (PLAN-AdmissionControl.md §4), so it is a
# wire contract, not a log message - two literals would drift.
AT_CAPACITY_REASON = "at-capacity"


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


class TranscriptionCapacityError(Exception):
    """
    Represents a session refused because the worker it was placed on has no
    capacity for it (PLAN-AdmissionControl.md §4)

    Deliberately NOT a subclass of TranscriptionClientError, and deliberately
    not routed through it. TranscriptionClientError closes the socket with
    `1007` ("invalid frame payload data"), which is the exact misattribution
    PR #171 removed when it stopped reporting saturation as a client protocol
    fault - a busy refusal delivered through 1007 would be the same mistake
    wearing a new hat. A sibling type is what lets the controller map this to
    `1013` ("Try Again Later") without an ordering-sensitive isinstance chain,
    and what lets a test assert the two are not interchangeable.

    Nothing about this is the client's fault, so the message is a machine
    readable reason (AT_CAPACITY_REASON) rather than a human sentence: it is
    echoed verbatim as the WebSocket close reason.
    """

    def __init__(self, message: str, *args: object):
        """
        Args:
            message     - Close reason sent to the client. Callers pass
                            AT_CAPACITY_REASON; it is a parameter rather than a
                            constant baked in here only so a future refusal
                            with a genuinely different cause can say so, and it
                            stays required so no caller can emit a reason it
                            did not choose.
        """
        super().__init__(message, *args)
        self.message = message
