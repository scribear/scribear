"""
Defines MetricsAuthService for authenticating internal telemetry consumers
"""

import hmac

from src.shared.config import Config

BEARER_PREFIX = "Bearer "


class MetricsAuthService:
    """
    Service for authenticating readers of the metrics endpoint

    Deliberately a separate class from AuthService rather than a second method
    on it, so the two keys cannot be confused at a call site. They grant very
    different things: the API key opens transcription sessions and streams
    audio, while this key only reads counters. Sharing one secret would mean a
    compromise of the monitoring sidecar - the least privileged component in
    the deployment, and the one with a Docker socket mounted - also grants the
    ability to open ASR sessions.
    """

    @property
    def is_enabled(self) -> bool:
        """
        Whether a metrics key is configured

        An unset key disables the endpoint entirely; the route is not
        registered, so it 404s rather than 401s. A disabled endpoint should
        not look like a misconfigured credential.
        """
        return self._metrics_api_key != ""

    def __init__(self, config: Config):
        """
        Args:
            config  - Application config
        """
        self._metrics_api_key = config.metrics_api_key

    def is_authenticated(self, authorization_header: str | None) -> bool:
        """
        Checks an Authorization header against the configured metrics key

        Args:
            authorization_header    - Raw header value, or None if absent

        Returns:
            True only for a well formed bearer credential that matches
        """
        # Belt and braces: with no key configured the route is never
        # registered, so this is unreachable - but a future caller that
        # forgets that must not get an open endpoint.
        if not self.is_enabled:
            return False

        if authorization_header is None:
            return False
        if not authorization_header.startswith(BEARER_PREFIX):
            return False

        presented = authorization_header[len(BEARER_PREFIX) :]

        # Constant time: a plain == leaks the shared prefix length through
        # timing, which is enough to recover a key one byte at a time.
        return hmac.compare_digest(presented, self._metrics_api_key)
