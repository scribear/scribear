import type { AppDependencies } from '@/server/dependency-injection/register-dependencies.js';

import type {
  ListScheduledSessionsParams,
  ScheduledSessionRow,
} from './scheduled-session.repository.js';

export interface CreateScheduledSessionInput {
  kioskId: string;
  title: string;
  sessionLength: number;
  scheduledAt: string;
  recurrenceRule?: string | null | undefined;
}

export interface UpdateScheduledSessionInput {
  kioskId?: string | undefined;
  title?: string | undefined;
  sessionLength?: number | undefined;
  scheduledAt?: string | undefined;
  recurrenceRule?: string | null | undefined;
}

export interface ScheduledSessionDTO {
  id: string;
  kioskId: string;
  title: string;
  sessionLength: number;
  scheduledAt: string;
  recurrenceRule: string | null;
}

export class ScheduledSessionService {
  private _log: AppDependencies['logger'];
  private _repo: AppDependencies['scheduledSessionRepository'];

  constructor(
    logger: AppDependencies['logger'],
    scheduledSessionRepository: AppDependencies['scheduledSessionRepository'],
  ) {
    this._log = logger;
    this._repo = scheduledSessionRepository;
  }

  async create(
    input: CreateScheduledSessionInput,
  ): Promise<ScheduledSessionDTO> {
    this._log.info(
      { title: input.title, kioskId: input.kioskId, scheduledAt: input.scheduledAt },
      'Creating scheduled session',
    );

    const row = await this._repo.create({
      kiosk_id: input.kioskId,
      title: input.title,
      session_length: input.sessionLength,
      scheduled_at: new Date(input.scheduledAt),
      recurrence_rule: input.recurrenceRule ?? null,
    });

    return this._toDTO(row);
  }

  async getById(id: string): Promise<ScheduledSessionDTO | undefined> {
    const row = await this._repo.findById(id);
    return row ? this._toDTO(row) : undefined;
  }

  async list(
    params: ListScheduledSessionsParams,
  ): Promise<{ items: ScheduledSessionDTO[]; total: number }> {
    const { items, total } = await this._repo.list(params);
    return {
      items: items.map((row) => this._toDTO(row)),
      total,
    };
  }

  async update(
    id: string,
    input: UpdateScheduledSessionInput,
  ): Promise<ScheduledSessionDTO | undefined> {
    this._log.info({ id }, 'Updating scheduled session');

    const updateData: Partial<Omit<ScheduledSessionRow, 'id'>> = {};
    if (input.kioskId !== undefined) updateData.kiosk_id = input.kioskId;
    if (input.title !== undefined) updateData.title = input.title;
    if (input.sessionLength !== undefined)
      updateData.session_length = input.sessionLength;
    if (input.scheduledAt !== undefined)
      updateData.scheduled_at = new Date(input.scheduledAt);
    if (input.recurrenceRule !== undefined)
      updateData.recurrence_rule = input.recurrenceRule;

    if (Object.keys(updateData).length === 0) {
      return this.getById(id);
    }

    const row = await this._repo.update(id, updateData);
    return row ? this._toDTO(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    this._log.info({ id }, 'Deleting scheduled session');
    return this._repo.delete(id);
  }

  private _toDTO(row: ScheduledSessionRow): ScheduledSessionDTO {
    return {
      id: row.id,
      kioskId: row.kiosk_id,
      title: row.title,
      sessionLength: row.session_length,
      scheduledAt: new Date(row.scheduled_at).toISOString(),
      recurrenceRule: row.recurrence_rule,
    };
  }
}