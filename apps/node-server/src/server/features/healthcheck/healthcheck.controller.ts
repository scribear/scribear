import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import type { HEALTHCHECK_SCHEMA } from '@scribear/node-server-schema';

export class HealthcheckController {
  healthcheck(
    req: BaseFastifyRequest<typeof HEALTHCHECK_SCHEMA>,
    res: BaseFastifyReply<typeof HEALTHCHECK_SCHEMA>,
  ) {
    res.code(200).send({});
  }
}
