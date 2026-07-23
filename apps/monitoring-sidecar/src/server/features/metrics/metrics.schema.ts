import { Type } from 'typebox';

import { MONITORING_BASE_PATH } from '#src/server/base-path.js';

/**
 * The snapshot payload is intentionally declared loosely.
 *
 * Metric label sets are open-ended (a new close reason or provider key adds a
 * series without a schema change), so pinning an exact object shape here would
 * make the serializer silently drop new series — a monitoring system that
 * hides data it did not expect is worse than one with a permissive schema.
 */
export const SNAPSHOT_SCHEMA = {
  response: {
    200: Type.Any(),
  },
};

export const SNAPSHOT_ROUTE = {
  method: 'GET' as const,
  url: `${MONITORING_BASE_PATH}/snapshot`,
};

export const ALERTS_SCHEMA = {
  response: {
    200: Type.Any(),
  },
};

export const ALERTS_ROUTE = {
  method: 'GET' as const,
  url: `${MONITORING_BASE_PATH}/alerts`,
};

export const PROMETHEUS_SCHEMA = {
  response: {
    200: Type.String(),
  },
};

/**
 * Unversioned and unprefixed, matching the convention every Prometheus scraper
 * assumes by default.
 */
export const PROMETHEUS_ROUTE = {
  method: 'GET' as const,
  url: '/metrics',
};
