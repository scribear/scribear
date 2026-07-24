import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/**
 * Surfaces the demo caption room to the admin console: whether
 * it is enabled, whether its seeded session is currently joinable, and a
 * currently-valid join code when it is. A thin pass-through of the Session
 * Manager's `demo-room/status` (reached with the admin API key via the
 * gateway); the console turns the join code into a `/client/#config=...`
 * deep-link itself, since that link is same-origin behind the reverse proxy.
 */
export class DemoRoomController {
  private _gateway: AppDependencies['sessionManagerGatewayService'];

  constructor(
    sessionManagerGatewayService: AppDependencies['sessionManagerGatewayService'],
  ) {
    this._gateway = sessionManagerGatewayService;
  }

  async status(req: BaseFastifyRequest, res: BaseFastifyReply) {
    this._gateway.respond(req, res, await this._gateway.getDemoRoomStatus());
  }
}
