"""
Defines AuthService for authenticating clients
"""

from src.shared.config import Config


class AuthService:
    """
    Service for authenticating clients
    """

    def __init__(self, config: Config):
        self._api_key = config.api_key

    def is_authenticated(self, key: str):
        """
        Checks if given key matches configured API key
        """
        return self._api_key == key
