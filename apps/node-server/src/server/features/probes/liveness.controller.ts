import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { LIVENESS_SCHEMA } from '@scribear/node-server-schema';

export class LivenessController {
  liveness(
    _req: BaseFastifyRequest<typeof LIVENESS_SCHEMA>,
    res: BaseFastifyReply<typeof LIVENESS_SCHEMA>,
  ) {
    res.code(200).send({ status: 'ok' });
  }
}
