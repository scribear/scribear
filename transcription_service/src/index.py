"""
Entrypoint for whisper service. Load config, initializes services, and starts web server.
"""

import uvicorn

from src.shared.config import Config
from src.shared.logger import JsonFormatter, PrettyPrintFormatter, create_logger
from src.webserver import create_webserver


def main():
    """
    Whisper service entry point
    """
    config = Config()
    logger = create_logger(
        config.log_level,
        PrettyPrintFormatter() if config.is_development else JsonFormatter(),
    )
    uvicorn.run(
        lambda: create_webserver(config, logger),
        log_config=None,
        port=config.port,
        host=config.host,
        use_colors=False,
        factory=True,
    )


if __name__ == "__main__":
    main()
