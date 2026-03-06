import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { HttpError } from '@scribear/base-fastify-server';
import type {
  CREATE_SCHEDULED_SESSION_SCHEMA,
  DELETE_SCHEDULED_SESSION_SCHEMA,
  GET_SCHEDULED_SESSION_SCHEMA,
  LIST_SCHEDULED_SESSIONS_SCHEMA,
  UPDATE_SCHEDULED_SESSION_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

class ScheduledSessionController {
  private _scheduledSessionService: AppDependencies['scheduledSessionService'];

  constructor(
    scheduledSessionService: AppDependencies['scheduledSessionService'],
  ) {
    this._scheduledSessionService = scheduledSessionService;
  }

  async create(
    req: BaseFastifyRequest<typeof CREATE_SCHEDULED_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_SCHEDULED_SESSION_SCHEMA>,
  ) {
    const session = await this._scheduledSessionService.create(req.body);
    res.code(201).send(session);
  }

  async getById(
    req: BaseFastifyRequest<typeof GET_SCHEDULED_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof GET_SCHEDULED_SESSION_SCHEMA>,
  ) {
    const session = await this._scheduledSessionService.getById(req.params.id);

    if (!session) {
      throw new HttpError.NotFound('Scheduled session not found');
    }

    res.code(200).send(session);
  }

  async list(
    req: BaseFastifyRequest<typeof LIST_SCHEDULED_SESSIONS_SCHEMA>,
    res: BaseFastifyReply<typeof LIST_SCHEDULED_SESSIONS_SCHEMA>,
  ) {
    const result = await this._scheduledSessionService.list({
      limit: req.query.limit ?? 20,
      offset: req.query.offset ?? 0,
      from: req.query.from,
      to: req.query.to,
    });

    res.code(200).send(result);
  }

  async update(
    req: BaseFastifyRequest<typeof UPDATE_SCHEDULED_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof UPDATE_SCHEDULED_SESSION_SCHEMA>,
  ) {
    const session = await this._scheduledSessionService.update(
      req.params.id,
      req.body,
    );

    if (!session) {
      throw new HttpError.NotFound('Scheduled session not found');
    }

    res.code(200).send(session);
  }

  async delete(
    req: BaseFastifyRequest<typeof DELETE_SCHEDULED_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof DELETE_SCHEDULED_SESSION_SCHEMA>,
  ) {
    const deleted = await this._scheduledSessionService.delete(req.params.id);

    if (!deleted) {
      throw new HttpError.NotFound('Scheduled session not found');
    }

    res.code(204).send();
  }
}

export default ScheduledSessionController;