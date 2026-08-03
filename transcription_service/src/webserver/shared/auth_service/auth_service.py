"""
Defines AuthService for authenticating clients
"""

import hmac

from src.shared.config import Config

DEPLOYMENT_DOCS_URL = "https://github.com/scribear/scribear/wiki/Deployment"

# The marker every secret in deployment/.env.example is stubbed with. Matched
# as a case-insensitive substring rather than by equality: some stubs carry a
# suffix that exists only to satisfy a length rule, and an equality check would
# pass exactly those.
PLACEHOLDER_MARKER = "CHANGEME"


class AuthService:
    """
    Service for authenticating clients
    """

    def __init__(self, config: Config):
        """
        Args:
            config  - Application config

        Raises:
            ValueError  - If API_KEY is empty or still the .env.example stub
        """
        api_key = config.api_key

        # Unlike METRICS_API_KEY, an empty API_KEY does not mean "disabled" -
        # nothing here checks for that, so `"" == ""` would authenticate every
        # caller that sends no key at all. Compose substitutes a blank string
        # for an unset variable, so this is the shape a missing key arrives in.
        if api_key == "":
            raise ValueError(
                "API_KEY is empty. An empty key matches the empty credential an "
                "unauthenticated caller presents, so it opens transcription "
                "sessions to anyone rather than closing them. Set a strong, "
                f"high-entropy secret before starting - see {DEPLOYMENT_DOCS_URL}."
            )
        if PLACEHOLDER_MARKER in api_key.upper():
            raise ValueError(
                f'API_KEY still contains the placeholder "{PLACEHOLDER_MARKER}" '
                "from deployment/.env.example. Set a strong, high-entropy secret "
                f"before starting - see {DEPLOYMENT_DOCS_URL}."
            )

        self._api_key = api_key

    def is_authenticated(self, key: str):
        """
        Checks if given key matches configured API key
        """
        # Constant time: a plain == leaks the shared prefix length through
        # timing, which is enough to recover the key one byte at a time. This
        # matches what MetricsAuthService already does.
        return hmac.compare_digest(key, self._api_key)
