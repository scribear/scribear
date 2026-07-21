"""
Key layout and heartbeat timings for the fleet telemetry backplane (B1.7)

Restated by hand from `infra/scribear-redis/src/telemetry/telemetry-keys.ts`
and `telemetry-timing.ts`, which are the contract. This service shares no
package with the Node apps, so the choice is between restating the constants
here and inventing a second spelling of them; the constants are few, and the
reader that must agree with them - admin-server - imports the originals. The
same duplication exists in the other direction: the TypeScript side restates
the worker and provider shapes this service produces.

The pattern is snapshot-plus-index. This host rewrites one snapshot key every
heartbeat under a TTL of several heartbeats, and adds itself to a sorted index
scored by its own wall clock. Nothing ever deletes: liveness is expiry, so a
host that stops writing stops existing and a `kill -9`'d one needs no cleanup
path. The one sharp edge is that sorted-set members carry no TTL of their own,
which is why every publisher prunes the index by score - see the publisher.
"""

TELEMETRY_NAMESPACE = "scribe:v1"

# Index of Transcription Service hosts that have published recently. Member is
# the host identity, score is the publish time in epoch milliseconds.
TRANSCRIPTION_HOST_INDEX_KEY = (
    f"{TELEMETRY_NAMESPACE}:transcription-hosts:index"
)

# How often this host republishes its provider health, in seconds.
#
# Slower than the Node Server beat because this payload is per-host rather than
# per-session and changes far less often: providers are configured at boot,
# worker utilization is already a rolling average, and the remote reachability
# probe behind it is cached, so beating faster would republish an unchanged
# answer.
TRANSCRIPTION_HOST_HEARTBEAT_SEC = 5.0

# Expiry on this host's snapshot key, in milliseconds.
#
# Five heartbeats, which tolerates four consecutive missed writes - a GC pause,
# a Redis failover, a slow tick - before a healthy host disappears from the
# fleet view, while still surfacing a genuinely dead one within seconds.
TRANSCRIPTION_HOST_TTL_MS = int(TRANSCRIPTION_HOST_HEARTBEAT_SEC * 1000) * 5


def transcription_host_snapshot_key(transcription_host: str) -> str:
    """
    Builds the snapshot key for one Transcription Service host

    Args:
        transcription_host  - Identity this host publishes under

    Returns:
        Redis key holding this host's entire provider health body

    One key per host, holding every provider - not one key per provider. A host
    publishes all of its providers from a single read of its registry, so
    splitting them buys no independent freshness, and holding them together is
    what makes each read internally consistent: the worker list and the
    providers that ran on those workers are always from the same instant.

    The identity is interpolated, so it must not contain ':' - Config rejects
    that at boot rather than letting a heartbeat forge a key elsewhere in the
    namespace.
    """
    return f"{TELEMETRY_NAMESPACE}:ts:{transcription_host}"
