import { describe, expect } from 'vitest';

import * as nodeServerSchema from '@scribear/node-server-schema';

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
const ALL_EXPORTS: Record<string, unknown> = nodeServerSchema;

/** Every exported route schema that declares an `authorization` header. */
function routeSchemasWithAuthHeader(): [string, HeadersJsonSchema][] {
  const found: [string, HeadersJsonSchema][] = [];
  for (const [name, value] of Object.entries(ALL_EXPORTS)) {
    if (typeof value !== 'object' || value === null) continue;
    const headers = (value as { headers?: unknown }).headers;
    if (typeof headers !== 'object' || headers === null) continue;
    const candidate = headers as HeadersJsonSchema;
    if (!candidate.properties?.['authorization']) continue;
    found.push([name, candidate]);
  }
  return found;
}

describe('Service API key Authorization header schema', () => {
  describe('coverage', (it) => {
    it('finds the route schemas it is meant to be guarding', () => {
      // Assert - a rename that made the walk above match nothing would turn
      // every `it.each` below into a silent pass, so pin a floor. Only /status
      // takes the service key today.
      expect(routeSchemasWithAuthHeader().length).toBeGreaterThanOrEqual(1);
    });
  });

  describe.each(routeSchemasWithAuthHeader())('%s', (_name, headers) => {
    describe('credential failures cannot become 400s', (it) => {
      it('does not require the authorization header', () => {
        // Assert - request validation runs before serviceApiKeyHook, so a
        // required header answers a *missing* credential with 400
        // VALIDATION_ERROR instead of 401.
        expect(headers.required ?? []).not.toContain('authorization');
      });

      it('puts no pattern on the authorization header', () => {
        // Assert - a pattern here decides the status code for a credential the
        // hook never sees, so it can answer 400 to a *correct* key whose
        // encoding it did not anticipate. `^Bearer [A-Za-z0-9_-]+$` did exactly
        // that to any key from `openssl rand -base64 32`, which emits `+`, `/`
        // and `=`. Rationale and rejected alternatives:
        // libs/schemas/node-server-schema/src/shared/security/service-api-key.ts.
        expect(headers.properties?.['authorization']?.pattern).toBeUndefined();
      });
    });
  });
});
