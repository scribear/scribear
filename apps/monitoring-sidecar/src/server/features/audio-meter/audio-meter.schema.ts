import { Type } from 'typebox';

import { MONITORING_BASE_PATH } from '#src/server/base-path.js';

export const AUDIO_METER_SCHEMA = {
  response: {
    200: Type.String(),
  },
};

/**
 * The standalone audio meter (plan item A4).
 *
 * The page is self-contained and needs no backend, so this route is a
 * convenience only — a copy of the same file opened over `file://` works
 * identically, which is how an engineer sitting at the source machine will
 * usually reach it. Note the sidecar is not published through nginx, so this
 * URL is reachable from the backend network (or a port-forward), not the
 * public internet.
 */
export const AUDIO_METER_ROUTE = {
  method: 'GET' as const,
  url: `${MONITORING_BASE_PATH}/audio-meter`,
};
