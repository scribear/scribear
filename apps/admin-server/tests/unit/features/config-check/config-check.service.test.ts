import { describe, expect, vi } from 'vitest';

import type { ConfigCheckConfig } from '#src/server/features/config-check/config-check.service.js';
import {
  ConfigCheckService,
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
  dbHost: 'scribear-db',
  dbName: 'scribear',
  dbUser: 'scribear',
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

/** The two calls `_checkDatabase` makes; each test breaks one of them. */
interface DbClientLike {
  ping: () => Promise<void>;
  hasAdminSchema: () => Promise<boolean>;
}

/** A database that is up and migrated. */
const REACHABLE_DB: DbClientLike = {
  ping: () => Promise.resolve(),
  hasAdminSchema: () => Promise.resolve(true),
};

/**
 * A `ConfigCheckService` whose only live dependency is the database: fleet
 * telemetry is off and every probed service answers, so the findings from
 * `check()` are exactly the ones `_checkDatabase` produced.
 */
function dbService(
  dbClient: DbClientLike,
  overrides: Partial<ConfigCheckConfig> = {},
): ConfigCheckService {
  type Args = ConstructorParameters<typeof ConfigCheckService>;
  return new ConfigCheckService(
    { ...CLEAN, ...overrides },
    { enabled: false } as unknown as Args[1],
    { check: () => Promise.resolve([]) } as unknown as Args[2],
    dbClient as unknown as Args[3],
  );
}

async function dbIds(
  dbClient: DbClientLike,
  overrides: Partial<ConfigCheckConfig> = {},
): Promise<string[]> {
  const report = await dbService(dbClient, overrides).check();
  return report.findings.map((f) => f.id);
}

/** One row of the health rollup, as `HealthCheckerService.check()` returns. */
interface HealthComponentLike {
  name: string;
  status: string;
  latencyMs: number;
  detail?: string;
}

/**
 * A `ConfigCheckService` whose health rollup returns exactly `components` (and
 * whose database is healthy), so `check()`'s findings are what
 * `_checkServiceReachability` made of that rollup.
 */
function healthService(components: HealthComponentLike[]): ConfigCheckService {
  type Args = ConstructorParameters<typeof ConfigCheckService>;
  return new ConfigCheckService(
    CLEAN,
    { enabled: false } as unknown as Args[1],
    { check: () => Promise.resolve(components) } as unknown as Args[2],
    REACHABLE_DB as unknown as Args[3],
  );
}

async function healthIds(components: HealthComponentLike[]): Promise<string[]> {
  const report = await healthService(components).check();
  return report.findings.map((f) => f.id);
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
      expect(
        resolveEnvironment({ ...CLEAN, declaredEnv: 'prod' }),
      ).toStrictEqual({
        environment: 'production',
        environmentSource: 'inferred',
        declaredButInvalid: true,
      });
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

  describe('the session secret', (it) => {
    // Formerly a boot-time `minLength: 32`, which crashed the console over a
    // weak secret instead of reporting it. These checks are why it can be
    // relaxed to report-not-crash.
    it('flags a missing secret', () => {
      expect(ids({ adminSessionSecret: '' })).toContain(
        'admin-session-secret-missing',
      );
    });

    it('flags a secret shorter than 32 characters', () => {
      expect(
        ids({ adminSessionSecret: 'ajx82819xNUajcnajcjwkjkcnU' }),
      ).toContain('admin-session-secret-weak');
    });

    it('accepts a 32-character secret', () => {
      const found = ids({ adminSessionSecret: 'a'.repeat(32) });
      expect(found).not.toContain('admin-session-secret-weak');
      expect(found).not.toContain('admin-session-secret-missing');
    });

    // One mistake, one finding: a short placeholder is the placeholder check's,
    // not also the length check's.
    it('does not also flag a short placeholder as weak', () => {
      const found = ids({ adminSessionSecret: 'CHANGEME' });
      expect(found).toContain('admin-session-secret-placeholder');
      expect(found).not.toContain('admin-session-secret-weak');
    });

    it('is a warning in staging but blocks production', () => {
      const [found] = check({
        declaredEnv: 'staging',
        adminSessionSecret: 'ajx82819xNUajcnajcjwkjkcnU',
      }).filter((f) => f.id === 'admin-session-secret-weak');

      expect(found?.severity).toBe('warning');
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
        expect(
          f.remediation,
          `finding ${f.id} has no remediation`,
        ).toBeTruthy();
      }
    });
  });
});

describe('the database dependency', (it) => {
  it('reports nothing when configured, reachable and migrated', async () => {
    const found = await dbIds(REACHABLE_DB);
    expect(found).not.toContain('database-not-configured');
    expect(found).not.toContain('database-unreachable');
    expect(found).not.toContain('database-schema-missing');
  });

  it('flags a missing connection variable without trying to connect', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const found = await dbIds(
      { ping, hasAdminSchema: () => Promise.resolve(true) },
      { dbHost: '' },
    );

    expect(found).toContain('database-not-configured');
    expect(ping).not.toHaveBeenCalled();
  });

  it('flags a configured but unreachable database', async () => {
    const found = await dbIds({
      ping: () => Promise.reject(new Error('ECONNREFUSED')),
      hasAdminSchema: () => Promise.resolve(true),
    });

    expect(found).toContain('database-unreachable');
  });

  it('flags a reachable database whose schema was never migrated', async () => {
    const found = await dbIds({
      ping: () => Promise.resolve(),
      hasAdminSchema: () => Promise.resolve(false),
    });

    expect(found).toContain('database-schema-missing');
  });

  it('links each database finding to the deployment wiki', async () => {
    const report = await dbService(REACHABLE_DB, { dbHost: '' }).check();
    const finding = report.findings.find(
      (f) => f.id === 'database-not-configured',
    );

    expect(finding?.docUrl).toContain('github.com/scribear/scribear/wiki');
  });
});

describe('the service health rollup', (it) => {
  // The regression this guards: a service that is up but failing its own
  // readiness used to leave this page saying "nothing to report" while the
  // dashboard showed it red.
  it('reports a service that is up but failing its readiness', async () => {
    const report = await healthService([
      {
        name: 'session-manager',
        status: 'fail',
        latencyMs: 2,
        detail: 'database: fail',
      },
    ]).check();
    const failing = report.findings.find((f) => f.id === 'services-failing');

    expect(failing).toBeTruthy();
    // The failing service's own detail is carried through, verbatim.
    expect(failing?.detail).toContain('session-manager (database: fail)');
    expect(failing?.docUrl).toContain('github.com/scribear/scribear/wiki');
  });

  it('separates an unreachable service from a failing one', async () => {
    const found = await healthIds([
      {
        name: 'node-server',
        status: 'unreachable',
        latencyMs: 500,
        detail: 'connection failed',
      },
      {
        name: 'session-manager',
        status: 'fail',
        latencyMs: 2,
        detail: 'database: fail',
      },
    ]);

    expect(found).toContain('services-unreachable');
    expect(found).toContain('services-failing');
  });

  it('reports a degraded service below the severity of a failing one', async () => {
    const report = await healthService([
      {
        name: 'transcription-service',
        status: 'degraded',
        latencyMs: 2,
        detail: 'workers saturated',
      },
    ]).check();
    const degraded = report.findings.find((f) => f.id === 'services-degraded');

    expect(degraded).toBeTruthy();
    expect(degraded?.severity).not.toBe('critical');
  });

  it('says nothing when every component is ok', async () => {
    const found = await healthIds([
      { name: 'database', status: 'ok', latencyMs: 1 },
      { name: 'session-manager', status: 'ok', latencyMs: 2 },
    ]);

    expect(found).not.toContain('services-unreachable');
    expect(found).not.toContain('services-failing');
    expect(found).not.toContain('services-degraded');
  });
});
