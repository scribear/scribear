"""
Defines a custom log formatter for pretty-print logs for use in development
"""

import json
import logging

import colorama

# Colors for log level when logging in debug mode
_LEVEL_COLORS = {
    logging.DEBUG: colorama.Fore.BLUE,
    logging.INFO: colorama.Fore.GREEN,
    logging.WARNING: colorama.Fore.YELLOW,
    logging.ERROR: colorama.Fore.RED,
    # Highlight FATAL level
    logging.FATAL: f"{colorama.Back.RED}{colorama.Fore.BLACK}",
}
# Color for log message when logging in debug mode
_MESSAGE_COLOR = colorama.Fore.GREEN

# Mapping from log level number to level name
_LEVEL_NAMES = {
    logging.FATAL: "FATAL",
    logging.ERROR: "ERROR",
    logging.WARNING: "WARN",
    logging.INFO: "INFO",
    logging.DEBUG: "DEBUG",
}


class PrettyPrintFormatter(logging.Formatter):
    """
    Custom formatter for human-readable logs with terminal coloring
    Logs severity, timestamp, process id, message and additional context
    """

    def format(self, record: logging.LogRecord) -> str:
        # Format timestamp as HOUR:MIN:SEC.MILLISECOND
        time = f"[{self.formatTime(record, "%H:%M:%S")}.{record.msecs:.0f}]"

        # Map log level number to name and color accordingly
        level_color = _LEVEL_COLORS.get(record.levelno, "")
        level_name = _LEVEL_NAMES.get(record.levelno, "")
        level = f"{level_color}{level_name}{colorama.Style.RESET_ALL}"

        pid = f"({record.process}):"

        message = (
            f"{_MESSAGE_COLOR}{record.getMessage()}{colorama.Style.RESET_ALL}"
        )

        log_message = f"{time} {level} {pid} {message}"

        context = {}
        if "context" in record.__dict__:
            context = record.__dict__["context"]

        # Add exception info to context
        if record.exc_info:
            context["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            context["stack_info"] = self.formatStack(record.stack_info)

        # Format context as indented json string
        if context:
            context_str = json.dumps(context, indent=4)

            indented_context = "\n".join(
                [f"    {line}" for line in context_str.splitlines()]
            )
            log_message += f"\n{indented_context}"

        return log_message
