import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import { READINESS_SCHEMA } from './probes.schema.js';

export class ReadinessController {
  private _manager: AppDependencies['deviceRunManagerService'];

  constructor(
    deviceRunManagerService: AppDependencies['deviceRunManagerService'],
  ) {
    this._manager = deviceRunManagerService;
  }

  /**
   * Ready once at least one device has a token to authenticate as.
   *
   * A generator with neither token configured can do nothing at all: both
   * devices refuse to start, and the operator's panel is two disabled cards.
   * Reporting that as unready is what makes the common provisioning mistake —
   * deploying the service and forgetting the `.env` lines — visible in
   * `docker compose ps` rather than only after someone opens the page and
   * presses a button.
   *
   * It deliberately does *not* check that a room is assigned or a session is
   * active. Neither is this service's health: a test room with no session
   * scheduled is a completely normal resting state, and failing readiness for
   * it would have the container restart-looping over an empty calendar.
   */
  readiness(
    _req: BaseFastifyRequest<typeof READINESS_SCHEMA>,
    res: BaseFastifyReply<typeof READINESS_SCHEMA>,
  ) {
    if (!this._manager.anyConfigured) {
      res.code(503).send({
        status: 'fail',
        checks: {
          devices:
            'no device token configured; set TEST_AUDIO_GOOD_DEVICE_TOKEN and/or TEST_AUDIO_FAULT_DEVICE_TOKEN (deployment/provision-test-audio.sh mints them)',
        },
      });
      return;
    }
    res.code(200).send({ status: 'ok' });
  }
}
