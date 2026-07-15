import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export interface AuditRecordInput {
  actorSubject: string;
  actorProvider: string;
  action: string;
  target: string | null;
  paramsSummary: Record<string, unknown>;
  result: 'success' | 'failure';
  statusCode: number | null;
  requestId: string | null;
}

export interface AuditRow {
  id: string;
  actorSubject: string;
  actorProvider: string;
  action: string;
  target: string | null;
  paramsSummary: unknown;
  result: string;
  statusCode: number | null;
  requestId: string | null;
  createdAt: string;
}

export class AuditRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  async insert(input: AuditRecordInput): Promise<void> {
    await this._dbClient.db
      .insertInto('admin_audit_log')
      .values({
        actor_subject: input.actorSubject,
        actor_provider: input.actorProvider,
        action: input.action,
        target: input.target,
        params_summary: JSON.stringify(input.paramsSummary),
        result: input.result,
        status_code: input.statusCode,
        request_id: input.requestId,
      })
      .execute();
  }

  /** Most-recent-first page of audit rows (for the future /audit view). */
  async list(limit: number): Promise<AuditRow[]> {
    const rows = await this._dbClient.db
      .selectFrom('admin_audit_log')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      actorSubject: row.actor_subject,
      actorProvider: row.actor_provider,
      action: row.action,
      target: row.target,
      paramsSummary: row.params_summary,
      result: row.result,
      statusCode: row.status_code,
      requestId: row.request_id,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    }));
  }
}
