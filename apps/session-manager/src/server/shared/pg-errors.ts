import pg from 'pg';

/** Postgres SQLSTATE for an EXCLUDE constraint violation. */
const EXCLUSION_VIOLATION_CODE = '23P01';

/**
 * True if `e` is a `pg` driver error for an EXCLUDE constraint violation
 * (SQLSTATE `23P01`) — e.g. `sessions_no_overlap`. Callers that defer or
 * otherwise risk tripping an exclusion constraint at commit/statement time
 * use this to map the raw driver error to a friendly domain result instead
 * of letting it surface as an unhandled 500.
 */
export function isPgExclusionViolation(e: unknown): boolean {
  return e instanceof pg.DatabaseError && e.code === EXCLUSION_VIOLATION_CODE;
}
