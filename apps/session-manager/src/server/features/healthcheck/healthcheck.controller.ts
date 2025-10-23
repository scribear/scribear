import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { HEALTHCHECK_SCHEMA } from '@scribear/session-manager-schema';

class HealthcheckController {
  healthcheck(
    req: BaseFastifyRequest<typeof HEALTHCHECK_SCHEMA>,
    res: BaseFastifyReply<typeof HEALTHCHECK_SCHEMA>,
  ) {
    res.code(200).send({ reqId: req.id });
  }
}

export default HealthcheckController;
