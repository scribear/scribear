import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { HealthcheckSchema } from '@scribear/session-manager-schema';

class HealthcheckController {
  healthcheck(
    req: BaseFastifyRequest<typeof HealthcheckSchema>,
    res: BaseFastifyReply<typeof HealthcheckSchema>,
  ) {
    res.code(200).send({ reqId: req.id });
  }
}

export default HealthcheckController;
