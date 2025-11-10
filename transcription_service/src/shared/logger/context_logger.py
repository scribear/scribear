"""
Defines ContextLogger, a LoggerAdapter for managing inheritable log context
"""

import logging
from typing import Any, MutableMapping


class ContextLogger(logging.LoggerAdapter[logging.Logger]):
    """
    A logger adapter that provides inheritable context for logs.
    Allows child loggers to inherit parent context as well as
    ad hoc context for specific log events

    Note: A formatter that supports formatting context is needed.

    Usage:
    ```
    # Setup logger with formatter
    logger = ...

    base = ContextLogger(logger, context={"base": "logger"})

    # extra={"base": "logger"} is passed to logger
    base.info("")

    # extra={"base": "override", "add": 1}
    base.info("", context={"base": "override", "add": 1})

    child = base.child({"child": True})

    # extra={"base": "logger", "child": True}
    child.info("")

    grandchild = child.child({"base": None, "grand": True})

    # extra={"base": None, "child": True, "grand": True}
    grandchild.info("")
    ```
    """

    @property
    def context(self):
        """
        Fetches a copy of the logger's context
        """
        return self._context.copy()

    def __init__(
        self, logger: logging.Logger, context: dict[str, Any] | None = None
    ) -> None:
        """
        Args:
            logger  - Logger instance logs should be written to
            context - Base context that logger should be created with
        """
        super().__init__(logger, {})
        self._context = context or {}

    def child(self, context: dict[str, Any] | None = None) -> "ContextLogger":
        """
        Creates a new child logger with inherited and new context.
        Child will inherit all of parent's context.
        If additional context is provided, context will be merged.
        Additional context takes precedence over parent context.

        Args:
            context     - Additional context for child

        Returns:
            A child instance of ContextLogger.
        """
        new_context = self._context.copy()
        new_context.update(context or {})
        return ContextLogger(self.logger, new_context)

    def process(self, msg: object, kwargs: MutableMapping[str, Any]):
        """
        Processes the log message to add context to the LogRecord to be logged.
        Adheres to python logging.LoggerAdapter.process interface.

        Args:
            msg         - Message object of log (unused)
            context     - Keyword argument that is part of kwargs. Used for ad hoc context

        Returns:
            kwargs with "extra" updated to be inherited context merged
            with ad hoc context and unchanged msgs
        """
        context = kwargs.pop("context", {})

        # Merge contexts
        merged_context = self._context.copy()
        merged_context.update(context)

        if "extra" in kwargs:
            kwargs["extra"]["context"] = merged_context
        else:
            kwargs["extra"] = {"context": merged_context}
        return msg, kwargs
