import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { okEnvelope } from '#src/server/shared/envelope/envelope.js';

import type { LIST_AUDIT_SCHEMA } from './audit.schema.js';

export class AuditController {
  private _auditRepository: AppDependencies['auditRepository'];

  constructor(auditRepository: AppDependencies['auditRepository']) {
    this._auditRepository = auditRepository;
  }

  /** Most-recent-first page of admin audit records. */
  async list(
    req: BaseFastifyRequest<typeof LIST_AUDIT_SCHEMA>,
    res: BaseFastifyReply,
  ) {
    const limit = req.query.limit ?? 50;
    const items = await this._auditRepository.list(limit);
    res.code(200).send(okEnvelope({ items }));
  }
}
