import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

/**
 * Upper bound on the messages one rejected snapshot contributes.
 *
 * `Value.Errors` is exhaustive by design, so a payload from the wrong shape
 * entirely reports one message per offending field per array element. The
 * caller logs these on every poll of every affected member, so an
 * unbounded list turns a shape drift into an unreadable log at the moment an
 * operator most needs to read it. The first few identify the drift; the rest
 * repeat it.
 */
const MAX_REPORTED_ERRORS = 8;

/**
 * Outcome of parsing one snapshot value read from the backplane.
 *
 * A bare `T | null` was the obvious signature and is the wrong one. The caller
 * drops what it cannot parse - the same hole-dropping it already applies to a
 * member whose key expired between the index read and the value read - and
 * those two cases need opposite reactions: an expiry is routine and must stay
 * quiet, a shape drift is the thing this validation exists to catch and must be
 * loud enough to act on. `null` alone makes them indistinguishable, so the
 * failure carries both why it failed and what specifically did not match.
 *
 * `errors` is pre-formatted text rather than the validator's error objects:
 * its only consumer is a log line, and keeping the shape opaque means a
 * consumer needs no direct dependency on the validation library to read it.
 */
export type SnapshotParseResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /**
       * `malformed-json` is a value that is not JSON at all - a truncated
       * write, or a key collision with a non-telemetry producer in a shared
       * key space. `schema-mismatch` is well-formed JSON that is not this
       * snapshot, which in practice means a publisher and a reader shipping
       * different versions of the shape.
       */
      reason: 'malformed-json' | 'schema-mismatch';
      errors: string[];
    };

/**
 * Parses and validates one snapshot value against the schema that defines it.
 *
 * Generic so the other snapshot types can adopt the same enforcement without
 * each restating this logic; the per-type wrappers exist next to their schemas
 * so a consumer imports one function and cannot reach for the unvalidated
 * `JSON.parse` by accident.
 *
 * Never throws. A malformed value is an expected input here, not an
 * exceptional one: this reads a key space several services write to, over a
 * network, with values that may be truncated or expiring mid-read.
 */
export function parseSnapshot<Schema extends TSchema>(
  schema: Schema,
  raw: string,
): SnapshotParseResult<Static<Schema>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: 'malformed-json',
      errors: [
        error instanceof Error ? error.message : 'JSON.parse threw a non-Error',
      ],
    };
  }

  if (Value.Check(schema, parsed)) return { ok: true, value: parsed };

  return {
    ok: false,
    reason: 'schema-mismatch',
    errors: Value.Errors(schema, parsed)
      .slice(0, MAX_REPORTED_ERRORS)
      .map((error) => `${error.instancePath || '/'}: ${error.message}`),
  };
}
