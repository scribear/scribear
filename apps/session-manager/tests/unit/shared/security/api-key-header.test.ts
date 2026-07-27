import { describe, expect } from 'vitest';

import * as sessionManagerSchema from '@scribear/session-manager-schema';

/**
 * A route schema's `headers`, as the JSON Schema fastify hands to ajv.
 *
 * Asserting on the JSON Schema rather than round-tripping through typebox's own
 * `Value.Check` on purpose: fastify compiles these with ajv (the live 400 body
 * read `must match pattern`, which is ajv's wording, not typebox's), so the
 * JSON Schema *is* the artefact that decided the bug.
 */
interface HeadersJsonSchema {
  required?: string[];
  properties?: Record<string, { pattern?: string } | undefined>;
}

/**
 * Widened to `unknown` values so the narrowing below is honest: the module's
 * own export types tell TypeScript no export is null, which makes the runtime
 * null guard look dead to `no-unnecessary-condition`.
 */
const ALL_EXPORTS: Record<string, unknown> = sessionManagerSchema;

/** Every exported route schema that declares an `authorization` header. */
function routeSchemasWithAuthHeader(): [string, HeadersJsonSchema][] {
  const found: [string, HeadersJsonSchema][] = [];
  for (const [name, value] of Object.entries(ALL_EXPORTS)) {
    if (typeof value !== 'object' || value === null) continue;
    const headers = (value as { headers?: unknown }).headers;
    if (typeof headers !== 'object' || headers === null) continue;
    const candidate = headers as HeadersJsonSchema;
    if (!candidate.properties?.authorization) continue;
    found.push([name, candidate]);
  }
  return found;
}

describe('API key Authorization header schemas', () => {
  describe('coverage', (it) => {
    it('finds the route schemas it is meant to be guarding', () => {
      // Assert - a rename that made the walk above match nothing would turn
      // every `it.each` below into a silent pass, so pin a floor. 33 routes
      // declare the header today (32 admin-key + session-config-stream).
      expect(routeSchemasWithAuthHeader().length).toBeGreaterThanOrEqual(33);
    });
  });

  describe.each(routeSchemasWithAuthHeader())('%s', (_name, headers) => {
    describe('credential failures cannot become 400s', (it) => {
      it('does not require the authorization header', () => {
        // Assert - request validation runs before the auth preHandler, so a
        // required header answers a *missing* credential with 400
        // VALIDATION_ERROR instead of 401. The hook treats absent and wrong
        // identically; this keeps the wire behaviour identical too.
        expect(headers.required ?? []).not.toContain('authorization');
      });

      it('puts no pattern on the authorization header', () => {
        // Assert - a pattern here decides the status code for a credential the
        // hook never sees, so it can answer 400 to a *correct* key whose
        // encoding it did not anticipate. `^Bearer [A-Za-z0-9_-]+$` did exactly
        // that to any key from `openssl rand -base64 32`, which emits `+`, `/`
        // and `=`. The full argument, including why widening the class was
        // rejected, is in node-server-schema's service-api-key.ts.
        expect(headers.properties?.authorization?.pattern).toBeUndefined();
      });
    });
  });
});
