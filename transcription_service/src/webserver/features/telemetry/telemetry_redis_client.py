"""
Defines the Redis connection used by the fleet telemetry publisher
"""

from redis.asyncio import Redis
from redis.backoff import NoBackoff
from redis.retry import Retry

# Seconds to wait for a connection, and for a command on an established one.
#
# Both are bounded well inside one heartbeat so that a Redis that accepts
# connections but stops answering cannot stall the beat loop past its period:
# the failure is reported and the next beat republishes the same keys, which is
# strictly better than a beat blocked indefinitely on a snapshot that is
# already stale by the time it would land.
TELEMETRY_SOCKET_TIMEOUT_SEC = 2.0


def create_telemetry_redis_client(redis_url: str) -> Redis:
    """
    Creates the Redis client for publishing telemetry

    Args:
        redis_url   - Connection URL, including credentials

    Returns:
        Redis client, not yet connected

    Fail-fast rather than durable, because nothing on this connection is worth
    waiting for: every value published to it is a snapshot the next heartbeat
    supersedes. Retries are therefore disabled outright - a command that did
    not answer is not worth resending when the next beat rewrites the same keys
    anyway - and both socket timeouts are short.

    Nothing connects here. `redis.asyncio` establishes the connection inside
    the first command that needs one, which is why this publisher can be
    constructed before the event loop is running and why its first beat either
    connects and succeeds or fails and is logged like any other beat.
    """
    return Redis.from_url(
        redis_url,
        socket_connect_timeout=TELEMETRY_SOCKET_TIMEOUT_SEC,
        socket_timeout=TELEMETRY_SOCKET_TIMEOUT_SEC,
        retry=Retry(NoBackoff(), 0),
        retry_on_timeout=False,
    )
