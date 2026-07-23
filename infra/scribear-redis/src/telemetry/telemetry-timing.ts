/**
 * Heartbeat and expiry timings for the telemetry backplane (B1.7).
 *
 * These live beside the key layout, and not in each publisher's config,
 * because a publisher's period and its key's TTL are one decision made twice:
 * a TTL shorter than the period makes every snapshot expire between writes and
 * the fleet view flicker empty, and the reader's staleness window has to match
 * the same number a third time. Keeping the pair here means the ratio is
 * visible, and a reader importing the TTL cannot drift from the publisher that
 * sets it.
 *
 * Each TTL is five heartbeats. That tolerates four consecutive missed writes -
 * a GC pause, a Redis failover, a slow tick - before a healthy instance
 * disappears from the fleet, while still surfacing a genuinely dead one within
 * seconds. Neither period is a sampling rate for the numbers themselves: every
 * counter in the payloads is monotonic and every gauge is read at publish time,
 * so a missed beat loses nothing but freshness.
 */

/**
 * How often a Node Server instance republishes its own and its sessions'
 * snapshots.
 *
 * Chosen to be faster than an operator can perceive, because these snapshots
 * are what the room grid renders; sub-second status changes are pushed as
 * events instead of by shortening this.
 */
export const NODE_HEARTBEAT_MS = 2000;

/** Expiry on Node Server instance, session and route keys. */
export const NODE_TTL_MS = 5 * NODE_HEARTBEAT_MS;

/**
 * How often a Transcription Service host republishes its provider health.
 *
 * Slower than the Node Server beat because the payload is per-host rather than
 * per-session and changes far less often: providers are configured at boot,
 * worker utilisation is already a rolling average, and the remote reachability
 * probe behind it is cached for ten seconds, so beating faster than that would
 * republish an unchanged answer.
 */
export const TRANSCRIPTION_HOST_HEARTBEAT_MS = 5000;

/** Expiry on Transcription Service host keys. */
export const TRANSCRIPTION_HOST_TTL_MS = 5 * TRANSCRIPTION_HOST_HEARTBEAT_MS;

/**
 * Minimum interval between audio-level stats (B2.1) publishes for the same
 * session.
 *
 * Provisional - matches NODE_HEARTBEAT_MS as a starting point, not
 * independently validated for this payload. Unlike the periods above this is
 * not a beat: `RedisSessionAudioPublisher` is push-based, triggered by
 * results arriving rather than a timer, so this is a per-session throttle
 * (the minimum gap between writes) rather than a fixed schedule. Revisit if
 * write volume or staleness becomes a real problem.
 */
export const AUDIO_STATS_MIN_PUBLISH_INTERVAL_MS = 2000;

/** Expiry on session audio-stats keys. */
export const AUDIO_STATS_TTL_MS = 5 * AUDIO_STATS_MIN_PUBLISH_INTERVAL_MS;
