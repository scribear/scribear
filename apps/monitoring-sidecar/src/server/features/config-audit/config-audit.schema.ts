import { Type } from 'typebox';

import { SECRET_PLACEHOLDERS_SCHEMA } from '@scribear/node-server-schema';

import { MONITORING_BASE_PATH } from '#src/server/base-path.js';

/**
 * Re-exposes node-server's self-reported secret-placeholder classification
 * (PLAN-ConfigCheck-Coverage Phase 2), read off `GET /status` — which the
 * sidecar already polls with a key it already holds
 * (`NODE_SERVER_SERVICE_API_KEY`) — and relayed here for Admin Server's
 * Config Check to read without ever being handed that key itself.
 *
 * Unauthenticated and backend-network-only, the same trust boundary
 * `/metrics` and `/probes/readiness` already carry: the sidecar sits on the
 * `backend` compose network only and is not exposed through nginx.
 *
 * `reason` is `Type.String()` rather than a closed literal union, matching
 * `StatusPollResult.reason` on `AbsoluteStatusPoller` — it is one of
 * `POLL_ERROR_REASONS` plus `disabled`/`not-yet-polled`, but pinning that set
 * here too would be the third restatement of it.
 */
export const CONFIG_AUDIT_SCHEMA = {
  description:
    'Secret-placeholder classification self-reported by node-server, relayed unchanged. `nodeServer.status` is `unavailable` whenever the sidecar cannot currently vouch for the classification - no service key configured, no poll completed yet, or the most recent poll failed - so a consumer never mistakes a stale or absent reading for a clean bill of health.',
  response: {
    200: Type.Object({
      nodeServer: Type.Union([
        Type.Object({
          status: Type.Literal('ok'),
          secretPlaceholders: SECRET_PLACEHOLDERS_SCHEMA,
        }),
        Type.Object({
          status: Type.Literal('unavailable'),
          reason: Type.String({
            description:
              "'disabled' (no NODE_SERVER_SERVICE_API_KEY configured on the sidecar), 'not-yet-polled' (enabled, but the first poll has not completed), or one of AbsoluteStatusPoller's POLL_ERROR_REASONS from the most recent poll.",
          }),
        }),
      ]),
    }),
  },
};

export const CONFIG_AUDIT_ROUTE = {
  method: 'GET' as const,
  url: `${MONITORING_BASE_PATH}/config-audit`,
};
