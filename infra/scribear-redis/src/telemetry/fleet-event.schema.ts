import { Type } from 'typebox';
import type { Static } from 'typebox';

/**
 * Sub-second delta pushed over `scribe:v1:events` (B1.7 §2.5) when a session's
 * connectivity changes, instead of waiting for the next Node Server heartbeat.
 *
 * Deliberately restates `transcriptionServiceConnected` / `sourceDeviceConnected`
 * rather than importing Node Server's client-facing `sessionStatus` message
 * schema: coupling an operator-facing telemetry payload to the client wire
 * protocol would mean neither could change independently, the same reasoning
 * `TranscriptionOrchestratorService.sessionSnapshots()` already applies to the
 * heartbeat snapshot. It also cannot import it - this package cannot depend on
 * an `apps/*` app.
 */
export const SESSION_STATUS_EVENT_SCHEMA = Type.Object({
  t: Type.Literal('session'),
  sessionUid: Type.String(),
  transcriptionServiceConnected: Type.Boolean(),
  sourceDeviceConnected: Type.Boolean(),
  at: Type.Integer({
    description:
      'Publish time in epoch milliseconds, on the publisher’s clock.',
  }),
});

/**
 * Every event shape publishable on `scribe:v1:events`, discriminated by `t`.
 *
 * Only the `session` variant has a writer today. A `node`/`provider` variant
 * belongs here once something actually publishes one - node and provider
 * liveness already have a signal (heartbeat + TTL expiry on their snapshot
 * keys), so there is no shape to guess yet. Add the member here, alongside its
 * publisher, when that changes.
 */
export const FLEET_EVENT_SCHEMA = Type.Union([SESSION_STATUS_EVENT_SCHEMA]);

/** @see {@link FLEET_EVENT_SCHEMA} */
export type FleetEvent = Static<typeof FLEET_EVENT_SCHEMA>;
