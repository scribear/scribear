import { describe, expect } from 'vitest';

import type { ConfigCheckConfig } from '#src/server/features/config-check/config-check.service.js';
import {
  evaluateStaticChecks,
  resolveEnvironment,
} from '#src/server/features/config-check/config-check.service.js';

/** A deployment with nothing wrong with it. Each test spoils one thing. */
const CLEAN: ConfigCheckConfig = {
  declaredEnv: 'production',
  isDevelopment: false,
  adminApiKey: 'a7f3c1e9d2b48065af13c9e7d0b2a4f6',
  adminSessionSecret: '9d41f0b7e6c25a83d9f14b07c6a2e5d803b1f7a49c6e2d05',
  adminLocalCredentials: 'engrit 4f9a2c7e1b83d05a',
  dbPassword: 'e2b7d94a1c60f38b',
  redisUrl: 'redis://:5c9e1a7f3d824b60@redis:6379',
  azureTenantId: 'tenant-1',
  azureClientId: 'client-1',
  azureClientSecret: '0b4e8d2a7f16c395',
  allowedGroup: 'scribear-admins',
};

function check(overrides: Partial<ConfigCheckConfig> = {}) {
  const config = { ...CLEAN, ...overrides };
  const { environment, declaredButInvalid } = resolveEnvironment(config);
  return evaluateStaticChecks(config, environment, declaredButInvalid);
}

function ids(overrides: Partial<ConfigCheckConfig> = {}): string[] {
  return check(overrides).map((f) => f.id);
}

describe('resolveEnvironment', () => {
  describe('an explicit value', (it) => {
    it.each(['development', 'staging', 'production'] as const)(
      'is taken at face value: %s',
      (declaredEnv) => {
        expect(resolveEnvironment({ ...CLEAN, declaredEnv })).toStrictEqual({
          environment: declaredEnv,
          environmentSource: 'explicit',
          declaredButInvalid: false,
        });
      },
    );

    it('is case- and whitespace-insensitive', () => {
      expect(
        resolveEnvironment({ ...CLEAN, declaredEnv: '  Production ' })
          .environment,
      ).toBe('production');
    });
  });

  describe('an unset value', (it) => {
    // The asymmetry is the safety property: every deployment predating this
    // variable has it unset, and guessing "development" would greet a real
    // deployment with reassuring green while its admin password was CHANGEME.
    it('infers production when the server is not in dev mode', () => {
      expect(
        resolveEnvironment({
          ...CLEAN,
          declaredEnv: '',
          isDevelopment: false,
        }),
      ).toStrictEqual({
        environment: 'production',
        environmentSource: 'inferred',
        declaredButInvalid: false,
      });
    });

    it('infers development only when the server was started with --dev', () => {
      expect(
        resolveEnvironment({ ...CLEAN, declaredEnv: '', isDevelopment: true })
          .environment,
      ).toBe('development');
    });
  });

  describe('an unrecognized value', (it) => {
    // Reported rather than fatal: a typo here must not be able to stop
    // admin-server from booting.
    it('falls back to the inferred environment and flags itself', () => {
      expect(resolveEnvironment({ ...CLEAN, declaredEnv: 'prod' })).toStrictEqual(
        {
          environment: 'production',
          environmentSource: 'inferred',
          declaredButInvalid: true,
        },
      );
    });

    it('produces a finding', () => {
      expect(ids({ declaredEnv: 'prod' })).toContain('deployment-env-invalid');
    });
  });
});

describe('evaluateStaticChecks', () => {
  describe('a fully configured production deployment', (it) => {
    it('reports nothing', () => {
      expect(check()).toStrictEqual([]);
    });
  });

  describe('placeholder secrets', (it) => {
    it.each([
      ['adminApiKey', 'admin-api-key-placeholder'],
      ['adminSessionSecret', 'admin-session-secret-placeholder'],
      ['dbPassword', 'db-password-placeholder'],
    ] as const)('are caught for %s', (field, expectedId) => {
      expect(ids({ [field]: 'CHANGEME' })).toContain(expectedId);
    });

    // The stubs with a length-rule suffix are the ones an operator is most
    // likely to keep, and the ones a `=== 'CHANGEME'` check would pass.
    it('are caught when the placeholder is only a substring', () => {
      expect(
        ids({
          adminSessionSecret:
            'CHANGEME-admin-session-secret-at-least-32-characters',
        }),
      ).toContain('admin-session-secret-placeholder');
    });

    it('are harmless in development but critical in production', () => {
      const [found] = check({
        declaredEnv: 'development',
        isDevelopment: true,
        dbPassword: 'CHANGEME',
      }).filter((f) => f.id === 'db-password-placeholder');

      expect(found?.severity).toBe('advisory');
      expect(found?.productionSeverity).toBe('critical');
    });
  });

  describe('login configuration', (it) => {
    it('flags a deployment nobody can sign in to', () => {
      expect(
        ids({
          adminLocalCredentials: '',
          azureTenantId: '',
          azureClientId: '',
          azureClientSecret: '',
        }),
      ).toContain('no-login-method');
    });

    it('flags a placeholder local password', () => {
      expect(ids({ adminLocalCredentials: 'engrit CHANGEME' })).toContain(
        'admin-local-credentials-placeholder',
      );
    });

    it('flags SSO left open to the whole tenant', () => {
      expect(ids({ allowedGroup: '' })).toContain('sso-no-group-restriction');
    });

    it('treats a shared local account as a production concern only', () => {
      const withoutSso = {
        azureTenantId: '',
        azureClientId: '',
        azureClientSecret: '',
      };
      const [found] = check({
        ...withoutSso,
        declaredEnv: 'development',
        isDevelopment: true,
      }).filter((f) => f.id === 'local-login-only');

      expect(found?.severity).toBe('ok');
      expect(found?.productionSeverity).toBe('warning');
    });
  });

  describe('the telemetry backplane', (it) => {
    it('reports being switched off as advisory, not broken', () => {
      const [found] = check({ redisUrl: '' }).filter(
        (f) => f.id === 'fleet-telemetry-disabled',
      );

      expect(found?.productionSeverity).toBe('warning');
    });

    it('flags a Redis URL with no password', () => {
      expect(ids({ redisUrl: 'redis://redis:6379' })).toContain(
        'redis-url-no-password',
      );
    });

    // Otherwise an unparseable URL produces two findings for one mistake, and
    // the misleading one ("no password") reads as the more actionable.
    it('does not also claim an unparseable URL has no password', () => {
      expect(ids({ redisUrl: 'not-a-url' })).not.toContain(
        'redis-url-no-password',
      );
    });
  });

  describe('the --dev flag', (it) => {
    it('is critical outside development, because the session cookie loses Secure', () => {
      const [found] = check({
        declaredEnv: 'production',
        isDevelopment: true,
      }).filter((f) => f.id === 'dev-flag-in-deployed-env');

      expect(found?.severity).toBe('critical');
    });

    it('is unremarkable in development', () => {
      expect(
        ids({ declaredEnv: 'development', isDevelopment: true }),
      ).not.toContain('dev-flag-in-deployed-env');
    });
  });

  describe('secret disclosure', (it) => {
    // The report is authenticated, but "authenticated" is not the same as
    // "cleared to read every credential", and this page is exactly the sort of
    // thing that ends up screenshotted into a ticket.
    it('never echoes a secret value, in any field of any finding', () => {
      const spoiled: ConfigCheckConfig = {
        ...CLEAN,
        declaredEnv: 'not-an-env',
        isDevelopment: true,
        adminApiKey: 'CHANGEME',
        adminSessionSecret: 'CHANGEME-admin-session-secret',
        adminLocalCredentials: 'engrit CHANGEME',
        dbPassword: 'CHANGEME',
        redisUrl: 'redis://:sup3rs3cr3tp4ss@redis:6379',
        allowedGroup: '',
      };
      const { environment, declaredButInvalid } = resolveEnvironment(spoiled);
      const serialized = JSON.stringify(
        evaluateStaticChecks(spoiled, environment, declaredButInvalid),
      );

      for (const secret of [
        CLEAN.adminApiKey,
        CLEAN.adminSessionSecret,
        CLEAN.dbPassword,
        'sup3rs3cr3tp4ss',
        '4f9a2c7e1b83d05a',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    });

    it('describes a placeholder by length rather than by value', () => {
      const [found] = check({ dbPassword: 'CHANGEME' }).filter(
        (f) => f.id === 'db-password-placeholder',
      );

      expect(found?.detail).toContain('8 chars');
    });
  });

  describe('every finding', (it) => {
    it('carries remediation naming a variable', () => {
      const all = check({
        declaredEnv: 'prod',
        adminApiKey: 'CHANGEME',
        adminSessionSecret: 'CHANGEME',
        dbPassword: 'CHANGEME',
        adminLocalCredentials: 'engrit CHANGEME',
        redisUrl: '',
        allowedGroup: '',
      });

      expect(all.length).toBeGreaterThan(0);
      for (const f of all) {
        expect(f.remediation, `finding ${f.id} has no remediation`).toBeTruthy();
      }
    });
  });
});
