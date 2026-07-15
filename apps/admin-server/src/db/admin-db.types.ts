import type { ColumnType } from 'kysely';

type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;

type Timestamp = ColumnType<Date, Date | string, Date | string>;

/**
 * `jsonb` column: Postgres returns parsed JSON on read; on write we pass a
 * JSON string (Postgres casts text -> jsonb), so the insert/update type is
 * `string`.
 */
type JsonColumn = ColumnType<unknown, string, string>;

/**
 * Append-only audit trail of admin actions performed through the BFF. Owned by
 * `admin-server` (separate migrator + migration-tracking tables) so it never
 * collides with the `@scribear/scribear-db` schema on the shared database.
 */
export interface AdminAuditLog {
  id: Generated<string>;
  /** Identity subject (e.g. local username, or SSO subject claim). */
  actor_subject: string;
  /** Identity provider that authenticated the actor (`local` | `sso`). */
  actor_provider: string;
  /** Machine action name, e.g. `create-room`, `delete-device`, `login`. */
  action: string;
  /** Primary target of the action (e.g. a room/device uid), if any. */
  target: string | null;
  /** Non-sensitive summary of request params. Never contains secrets. */
  params_summary: JsonColumn;
  /** Outcome: `success` | `failure`. */
  result: string;
  /** HTTP status returned to the client, when applicable. */
  status_code: number | null;
  /** Correlating request id (also emitted on the `X-Request-ID` header). */
  request_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface AdminDB {
  admin_audit_log: AdminAuditLog;
}
