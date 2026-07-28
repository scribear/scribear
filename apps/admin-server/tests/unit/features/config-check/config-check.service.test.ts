import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  LATEST_MIGRATION,
  MIGRATION_NAMES,
  type SchemaState,
} from '@scribear/scribear-db';

import type { ConfigCheckConfig } from '#src/server/features/config-check/config-check.service.js';
import {
  ConfigCheckService,
  evaluateStaticChecks,
  resolveEnvironment,
} from '#src/server/features/config-check/config-check.service.js';

/**
 * The sidecar is a core service with no compose profile, unlike Grafana/
 * Prometheus, so — unlike `grafanaBaseUrl`/`prometheusBaseUrl` below — `CLEAN`
 * gives it a real (test) URL rather than leaving it unset. The top-level
 * `beforeEach` near the bottom of this file stubs every test's `fetch` to
 * answer it cleanly by default, so `_checkSecretPlaceholders` fires no
 * findings for a test that does not care about it.
 */
const SIDECAR_TEST_URL = 'http://monitoring-sidecar.test';

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
  testAudioServiceKey: 'c3f8a2e91d5b7064af0e9d3c7b1a5e82',
  // Off by default, like a deployment that never turns on the monitoring
  // profile. `monitoringService` below turns it on with its own overrides.
  grafanaBaseUrl: '',
  prometheusBaseUrl: '',
  monitoringSidecarBaseUrl: SIDECAR_TEST_URL,
  azureTenantId: 'tenant-1',
  azureClientId: 'client-1',
  azureClientSecret: '0b4e8d2a7f16c395',
  allowedGroup: 'scribear-admins',
  upstreamTimeoutMs: 3_000,
};

function check(overrides: Partial<ConfigCheckConfig> = {}) {
  const config = { ...CLEAN, ...overrides };
  const { environment, declaredButInvalid } = resolveEnvironment(config);
  return evaluateStaticChecks(config, environment, declaredButInvalid);
}

function ids(overrides: Partial<ConfigCheckConfig> = {}): string[] {
  return check(overrides).map((f) => f.id);
}

/** The three calls `_checkDatabase` makes; each test breaks one of them. */
interface DbClientLike {
  ping: () => Promise<void>;
  hasAdminSchema: () => Promise<boolean>;
  scribearSchemaState: () => Promise<SchemaState>;
}

/**
 * A shared schema at exactly the version this build expects — which, since the
 * check compares against the real `MIGRATION_NAMES`, means the actual migration
 * list. Tests that care about a *mismatch* spoil this with `schemaState()`.
 */
const CURRENT_SCHEMA: SchemaState = {
  initialized: true,
  applied: [...MIGRATION_NAMES],
  expected: [...MIGRATION_NAMES],
  pending: [],
  unknown: [],
  upToDate: true,
  latestExpected: LATEST_MIGRATION,
  latestApplied: LATEST_MIGRATION,
};

/** `CURRENT_SCHEMA` with the named fields replaced. */
function schemaState(overrides: Partial<SchemaState> = {}): SchemaState {
  return { ...CURRENT_SCHEMA, ...overrides };
}

/** A database that is up, and migrated on both schemas. */
const REACHABLE_DB: DbClientLike = {
  ping: () => Promise.resolve(),
  hasAdminSchema: () => Promise.resolve(true),
  scribearSchemaState: () => Promise.resolve(CURRENT_SCHEMA),
};

/**
 * A `ConfigCheckService` whose only live dependency is the database: fleet
 * telemetry is off, every probed service answers, and session-manager reports the
 * same schema version this build expects, so the findings from `check()` are
 * exactly the ones `_checkDatabase` produced.
 *
 * `reportedLatest` is what session-manager answers with; `null` stands for a
 * service that could not be asked at all.
 */
function dbService(
  dbClient: DbClientLike,
  overrides: Partial<ConfigCheckConfig> = {},
  reportedLatest: string | null = LATEST_MIGRATION,
): ConfigCheckService {
  type Args = ConstructorParameters<typeof ConfigCheckService>;
  return new ConfigCheckService(
    { ...CLEAN, ...overrides },
    { enabled: false } as unknown as Args[1],
    { check: () => Promise.resolve([]) } as unknown as Args[2],
    dbClient as unknown as Args[3],
    gateway(reportedLatest) as unknown as Args[4],
  );
}

/**
 * A Session Manager gateway that reports `latest` as the schema version its
 * container expects. `null` simulates a service that did not answer — the client
 * returns a `[null, error]` tuple rather than throwing.
 */
function gateway(latest: string | null) {
  return {
    getSchemaStatus: () =>
      Promise.resolve(
        latest === null
          ? [null, new Error('unreachable')]
          : [{ status: 200, data: { latestExpected: latest } }, null],
      ),
  };
}

async function dbIds(
  dbClient: DbClientLike,
  overrides: Partial<ConfigCheckConfig> = {},
  reportedLatest: string | null = LATEST_MIGRATION,
): Promise<string[]> {
  const report = await dbService(dbClient, overrides, reportedLatest).check();
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
    gateway(LATEST_MIGRATION) as unknown as Args[4],
  );
}

async function healthIds(components: HealthComponentLike[]): Promise<string[]> {
  const report = await healthService(components).check();
  return report.findings.map((f) => f.id);
}

const PROMETHEUS_TEST_URL = 'http://prometheus.test';
const GRAFANA_TEST_URL = 'http://grafana.test';
const CONFIG_AUDIT_URL = `${SIDECAR_TEST_URL}/api/monitoring/v1/config-audit`;

/** One stubbed HTTP answer, or a network failure, keyed by URL prefix. */
type ProbeAnswers = Record<
  string,
  { status: number; body?: unknown } | 'network-error'
>;

/**
 * node-server reports every secret fine — the default `/config-audit` answer
 * everywhere except the `secret placeholders` describe below, which overrides
 * it to explore every other shape.
 */
const CONFIG_AUDIT_HEALTHY: { status: number; body: unknown } = {
  status: 200,
  body: {
    nodeServer: {
      status: 'ok',
      secretPlaceholders: {
        sessionTokenSigningKeyIsPlaceholder: false,
        sessionManagerServiceApiKeyIsPlaceholder: false,
        nodeServerServiceApiKeyIsPlaceholder: false,
        transcriptionServiceApiKeyIsPlaceholder: false,
      },
    },
  },
};

/**
 * Everything reachable and healthy: both monitoring endpoints answer, the
 * sidecar scrape target is up, the default Grafana password is rejected, and
 * node-server's secret audit comes back clean. Each monitoring test overrides
 * exactly the one answer it cares about.
 */
const MONITORING_HEALTHY: ProbeAnswers = {
  [`${PROMETHEUS_TEST_URL}/-/healthy`]: { status: 200 },
  [`${PROMETHEUS_TEST_URL}/api/v1/targets`]: {
    status: 200,
    body: {
      data: {
        activeTargets: [{ labels: { job: 'scribear_sidecar' }, health: 'up' }],
      },
    },
  },
  [`${GRAFANA_TEST_URL}/api/health`]: { status: 200 },
  // The real check: a probe that always tries admin/CHANGEME and nothing
  // else. Rejected here, since the "healthy" baseline models a deployment
  // that already changed the default password.
  [`${GRAFANA_TEST_URL}/api/org`]: { status: 401 },
  [CONFIG_AUDIT_URL]: CONFIG_AUDIT_HEALTHY,
};

function stubProbes(answers: ProbeAnswers) {
  vi.stubGlobal('fetch', (url: string) => {
    const match = Object.keys(answers).find((base) => url.startsWith(base));
    const answer = match === undefined ? undefined : answers[match];
    if (answer === undefined || answer === 'network-error') {
      return Promise.reject(new Error('connect ECONNREFUSED'));
    }
    return Promise.resolve(
      new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

/**
 * Every `.check()`-calling test needs a `/config-audit` answer regardless of
 * whether it cares about Phase 2 secrets — `_checkSecretPlaceholders` is
 * unconditional, unlike the Grafana/Prometheus probes above, since the
 * sidecar is a core service rather than behind the optional `monitoring`
 * profile. This keeps `dbService`/`healthService`-based tests hermetic
 * without every one of them having to know that. Tests that care about this
 * check (or about Grafana/Prometheus) call `stubProbes` themselves, which
 * replaces this default outright.
 */
beforeEach(() => {
  stubProbes({ [CONFIG_AUDIT_URL]: CONFIG_AUDIT_HEALTHY });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A `ConfigCheckService` with both monitoring base URLs wired to the stubbed
 * `fetch` above, and every other dependency healthy, so `check()`'s findings
 * are exactly what `_checkMonitoring` produced.
 */
function monitoringService(
  overrides: Partial<ConfigCheckConfig> = {},
): ConfigCheckService {
  type Args = ConstructorParameters<typeof ConfigCheckService>;
  return new ConfigCheckService(
    {
      ...CLEAN,
      grafanaBaseUrl: GRAFANA_TEST_URL,
      prometheusBaseUrl: PROMETHEUS_TEST_URL,
      ...overrides,
    },
    { enabled: false } as unknown as Args[1],
    { check: () => Promise.resolve([]) } as unknown as Args[2],
    REACHABLE_DB as unknown as Args[3],
    gateway(LATEST_MIGRATION) as unknown as Args[4],
  );
}

async function monitoringIds(
  overrides: Partial<ConfigCheckConfig> = {},
): Promise<string[]> {
  const report = await monitoringService(overrides).check();
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
      ['testAudioServiceKey', 'test-audio-service-key-placeholder'],
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

    // The realistic mistake: REDIS_PASSWORD was changed but the copied
    // `redis://:CHANGEME@redis:6379` example from .env.example was not.
    it('flags a Redis URL whose password is still the placeholder', () => {
      expect(ids({ redisUrl: 'redis://:CHANGEME@redis:6379' })).toContain(
        'redis-url-placeholder-password',
      );
    });

    it('does not flag a real password as a placeholder', () => {
      expect(ids()).not.toContain('redis-url-placeholder-password');
    });

    it('does not also claim an unparseable URL has a placeholder password', () => {
      expect(ids({ redisUrl: 'not-a-url' })).not.toContain(
        'redis-url-placeholder-password',
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
        testAudioServiceKey: 'CHANGEME',
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
        CLEAN.testAudioServiceKey,
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
    const found = await dbIds({ ...REACHABLE_DB, ping }, { dbHost: '' });

    expect(found).toContain('database-not-configured');
    expect(ping).not.toHaveBeenCalled();
  });

  it('flags a configured but unreachable database', async () => {
    const found = await dbIds({
      ...REACHABLE_DB,
      ping: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    expect(found).toContain('database-unreachable');
  });

  it('does not ask an unreachable database about its schema version', async () => {
    const scribearSchemaState = vi.fn(() => Promise.resolve(CURRENT_SCHEMA));
    await dbIds({
      ...REACHABLE_DB,
      ping: () => Promise.reject(new Error('ECONNREFUSED')),
      scribearSchemaState,
    });

    expect(scribearSchemaState).not.toHaveBeenCalled();
  });

  it("flags a reachable database missing admin-server's own schema", async () => {
    const found = await dbIds({
      ...REACHABLE_DB,
      hasAdminSchema: () => Promise.resolve(false),
    });

    expect(found).toContain('database-schema-missing');
  });

  // The two schemas fail separately and are fixed separately: admin-server
  // migrates its own tables at startup, the db-migrate job applies the shared
  // schema. Reporting only the first would hide the one that stops the stack
  // serving.
  it('reports both schemas when both are missing', async () => {
    const found = await dbIds({
      ...REACHABLE_DB,
      hasAdminSchema: () => Promise.resolve(false),
      scribearSchemaState: () =>
        Promise.resolve(
          schemaState({
            initialized: false,
            applied: [],
            pending: [...MIGRATION_NAMES],
            upToDate: false,
            latestApplied: '',
          }),
        ),
    });

    expect(found).toContain('database-schema-missing');
    expect(found).toContain('schema-never-migrated');
  });

  it('says nothing about the shared schema when it is current', async () => {
    const found = await dbIds(REACHABLE_DB);

    expect(found).not.toContain('schema-never-migrated');
    expect(found).not.toContain('schema-migrations-pending');
    expect(found).not.toContain('schema-ahead-of-containers');
    expect(found).not.toContain('schema-version-skew');
    expect(found).not.toContain('schema-version-unreadable');
  });

  it('links each database finding to the deployment wiki', async () => {
    const report = await dbService(REACHABLE_DB, { dbHost: '' }).check();
    const finding = report.findings.find(
      (f) => f.id === 'database-not-configured',
    );

    expect(finding?.docUrl).toContain('github.com/scribear/scribear/wiki');
  });
});

/**
 * The check the old deployment had no way to make: is the schema in the database
 * the one the running images were built against? Until migrations moved into the
 * stack this could only be inferred from a `database: fail` two steps away.
 */
describe('the shared schema version', (it) => {
  /** A `SchemaState` where the newest `count` migrations were never applied. */
  function behindBy(count: number): SchemaState {
    const applied = MIGRATION_NAMES.slice(0, MIGRATION_NAMES.length - count);
    const pending = MIGRATION_NAMES.slice(MIGRATION_NAMES.length - count);
    return schemaState({
      applied: [...applied],
      pending: [...pending],
      upToDate: false,
      latestApplied: applied[applied.length - 1] ?? '',
    });
  }

  function withState(
    state: SchemaState,
    overrides: Partial<ConfigCheckConfig> = {},
    reportedLatest: string | null = LATEST_MIGRATION,
  ): Promise<string[]> {
    return dbIds(
      { ...REACHABLE_DB, scribearSchemaState: () => Promise.resolve(state) },
      overrides,
      reportedLatest,
    );
  }

  it('flags a database that has never been migrated', async () => {
    const found = await withState(
      schemaState({
        initialized: false,
        applied: [],
        pending: [...MIGRATION_NAMES],
        upToDate: false,
        latestApplied: '',
      }),
    );

    expect(found).toContain('schema-never-migrated');
    // One statement of the problem, not two.
    expect(found).not.toContain('schema-migrations-pending');
  });

  it('flags pending migrations and names the first one', async () => {
    const report = await dbService({
      ...REACHABLE_DB,
      scribearSchemaState: () => Promise.resolve(behindBy(1)),
    }).check();
    const found = report.findings.find(
      (f) => f.id === 'schema-migrations-pending',
    );

    expect(found).toBeTruthy();
    expect(found?.detail).toContain(LATEST_MIGRATION);
    expect(found?.remediation).toContain('run-migrator.sh');
    expect(found?.docUrl).toContain('github.com/scribear/scribear/wiki');
  });

  // A missed migration is survivable on a dev box and stops a lecture in
  // production, so it must not be reported at one severity.
  it('is a warning in development and blocks production', async () => {
    const report = await dbService(
      {
        ...REACHABLE_DB,
        scribearSchemaState: () => Promise.resolve(behindBy(2)),
      },
      { declaredEnv: 'development', isDevelopment: true },
    ).check();
    const found = report.findings.find(
      (f) => f.id === 'schema-migrations-pending',
    );

    expect(found?.severity).toBe('warning');
    expect(found?.productionSeverity).toBe('critical');
  });

  // A rollback moves the images back and leaves the schema where it was. The
  // older code's queries still work, so this is reportable, not broken - and
  // never `critical`, or every rollback would light the page up red.
  it('reports a schema ahead of the images without calling it critical', async () => {
    const report = await dbService({
      ...REACHABLE_DB,
      scribearSchemaState: () =>
        Promise.resolve(
          schemaState({
            applied: [...MIGRATION_NAMES, '00009999-from-a-newer-image'],
            unknown: ['00009999-from-a-newer-image'],
            latestApplied: '00009999-from-a-newer-image',
          }),
        ),
    }).check();
    const found = report.findings.find(
      (f) => f.id === 'schema-ahead-of-containers',
    );

    expect(found).toBeTruthy();
    expect(found?.productionSeverity).not.toBe('critical');
    expect(found?.detail).toContain('00009999-from-a-newer-image');
  });

  it('flags containers built against different schema versions', async () => {
    const report = await dbService(
      REACHABLE_DB,
      {},
      '00000001-devices',
    ).check();
    const found = report.findings.find((f) => f.id === 'schema-version-skew');

    expect(found).toBeTruthy();
    expect(found?.detail).toContain('00000001-devices');
    expect(found?.detail).toContain(LATEST_MIGRATION);
  });

  // `services-unreachable` already reports a service that will not answer.
  // Guessing at its schema version would be a second finding for one cause.
  it('says nothing about skew when session-manager cannot be asked', async () => {
    const found = await withState(CURRENT_SCHEMA, {}, null);

    expect(found).not.toContain('schema-version-skew');
  });

  // Reporting "never migrated" here would send an operator to run migrations
  // that would fail for the same reason.
  it('distinguishes an unreadable migration table from an unmigrated one', async () => {
    const found = await dbIds({
      ...REACHABLE_DB,
      scribearSchemaState: () => Promise.reject(new Error('permission denied')),
    });

    expect(found).toContain('schema-version-unreadable');
    expect(found).not.toContain('schema-never-migrated');
  });

  it('carries remediation on every schema finding', async () => {
    const report = await dbService(
      {
        ...REACHABLE_DB,
        scribearSchemaState: () =>
          Promise.resolve(
            schemaState({
              ...behindBy(1),
              unknown: ['00009999-from-a-newer-image'],
            }),
          ),
      },
      {},
      '00000001-devices',
    ).check();
    const schemaFindings = report.findings.filter((f) =>
      f.id.startsWith('schema-'),
    );

    expect(schemaFindings.length).toBe(3);
    for (const f of schemaFindings) {
      expect(f.remediation, `finding ${f.id} has no remediation`).toBeTruthy();
    }
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

describe('the monitoring probes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('neither base URL configured', (it) => {
    it('reports the dashboard as not set up, not silence', async () => {
      stubProbes(MONITORING_HEALTHY);
      const report = await monitoringService({
        grafanaBaseUrl: '',
        prometheusBaseUrl: '',
      }).check();

      const found = report.findings.find(
        (f) => f.id === 'monitoring-not-configured',
      );
      expect(found).toBeTruthy();
      // Not development: a dashboard for a single throwaway container buys
      // nothing there, but staging/production is a warning, not silence.
      expect(found?.severity).toBe('warning');
    });

    it('is only advisory in development', async () => {
      const report = await monitoringService({
        grafanaBaseUrl: '',
        prometheusBaseUrl: '',
        declaredEnv: 'development',
      }).check();

      const found = report.findings.find(
        (f) => f.id === 'monitoring-not-configured',
      );
      expect(found?.severity).toBe('advisory');
    });

    it('probes nothing over the network', async () => {
      vi.stubGlobal('fetch', () => {
        throw new Error('unexpected fetch when monitoring is unconfigured');
      });

      await expect(
        monitoringService({
          grafanaBaseUrl: '',
          prometheusBaseUrl: '',
        }).check(),
      ).resolves.toBeTruthy();
    });
  });

  describe('both base URLs configured and healthy', (it) => {
    it('reports nothing', async () => {
      stubProbes(MONITORING_HEALTHY);
      const found = await monitoringIds();
      expect(found.filter((id) => id.startsWith('monitoring-'))).toEqual([]);
    });
  });

  describe('Prometheus', (it) => {
    it('reports unreachable when /-/healthy does not answer', async () => {
      stubProbes({
        ...MONITORING_HEALTHY,
        [`${PROMETHEUS_TEST_URL}/-/healthy`]: 'network-error',
      });
      expect(await monitoringIds()).toContain(
        'monitoring-prometheus-unreachable',
      );
    });

    it('reports not-scraping when the sidecar target is missing', async () => {
      stubProbes({
        ...MONITORING_HEALTHY,
        [`${PROMETHEUS_TEST_URL}/api/v1/targets`]: {
          status: 200,
          body: { data: { activeTargets: [] } },
        },
      });
      const found = await monitoringIds();
      expect(found).toContain('monitoring-prometheus-not-scraping');
      expect(found).not.toContain('monitoring-prometheus-unreachable');
    });

    it('reports not-scraping when the target is down rather than up', async () => {
      stubProbes({
        ...MONITORING_HEALTHY,
        [`${PROMETHEUS_TEST_URL}/api/v1/targets`]: {
          status: 200,
          body: {
            data: {
              activeTargets: [
                { labels: { job: 'scribear_sidecar' }, health: 'down' },
              ],
            },
          },
        },
      });
      expect(await monitoringIds()).toContain(
        'monitoring-prometheus-not-scraping',
      );
    });

    it('does not also ask about targets when unreachable', async () => {
      // Short-circuited like `_checkDatabase`: an unreachable Prometheus
      // cannot meaningfully be asked what it is scraping.
      stubProbes({
        [`${PROMETHEUS_TEST_URL}/-/healthy`]: 'network-error',
        [`${GRAFANA_TEST_URL}/api/health`]: { status: 200 },
        [`${GRAFANA_TEST_URL}/api/org`]: { status: 401 },
      });
      const found = await monitoringIds();
      expect(found).toContain('monitoring-prometheus-unreachable');
      expect(found).not.toContain('monitoring-prometheus-not-scraping');
    });
  });

  describe('Grafana', (it) => {
    it('reports unreachable when /api/health does not answer', async () => {
      stubProbes({
        ...MONITORING_HEALTHY,
        [`${GRAFANA_TEST_URL}/api/health`]: 'network-error',
      });
      expect(await monitoringIds()).toContain('monitoring-grafana-unreachable');
    });

    it('does not also probe the password when unreachable', async () => {
      stubProbes({
        [`${PROMETHEUS_TEST_URL}/-/healthy`]: { status: 200 },
        [`${PROMETHEUS_TEST_URL}/api/v1/targets`]: MONITORING_HEALTHY[
          `${PROMETHEUS_TEST_URL}/api/v1/targets`
        ] as { status: number; body?: unknown },
        [`${GRAFANA_TEST_URL}/api/health`]: 'network-error',
      });
      const found = await monitoringIds();
      expect(found).toContain('monitoring-grafana-unreachable');
      expect(found).not.toContain('monitoring-grafana-default-password');
    });

    describe('the default-password probe', (it) => {
      it('fires critical in staging/production when admin/CHANGEME is accepted', async () => {
        stubProbes({
          ...MONITORING_HEALTHY,
          [`${GRAFANA_TEST_URL}/api/org`]: { status: 200 },
        });
        const report = await monitoringService().check();
        const found = report.findings.find(
          (f) => f.id === 'monitoring-grafana-default-password',
        );
        expect(found).toBeTruthy();
        expect(found?.severity).toBe('critical');
      });

      it('does not fire when the credentials are rejected', async () => {
        // MONITORING_HEALTHY already answers 401 to admin/CHANGEME, modelling
        // a deployment that changed the default password.
        stubProbes(MONITORING_HEALTHY);
        expect(await monitoringIds()).not.toContain(
          'monitoring-grafana-default-password',
        );
      });

      it('sends exactly admin/CHANGEME over HTTP Basic auth, and nothing else', async () => {
        let sawAuthHeader: string | null = null;
        vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
          if (url.startsWith(`${GRAFANA_TEST_URL}/api/org`)) {
            const headers = new Headers(init?.headers);
            sawAuthHeader = headers.get('authorization');
            return Promise.resolve(new Response(null, { status: 401 }));
          }
          const match = Object.keys(MONITORING_HEALTHY).find((base) =>
            url.startsWith(base),
          );
          const answer =
            match === undefined ? undefined : MONITORING_HEALTHY[match];
          if (answer === undefined || answer === 'network-error') {
            return Promise.reject(new Error('connect ECONNREFUSED'));
          }
          return Promise.resolve(
            new Response(JSON.stringify(answer.body ?? {}), {
              status: answer.status,
            }),
          );
        });

        await monitoringService().check();

        expect(sawAuthHeader).toBe(
          `Basic ${Buffer.from('admin:CHANGEME').toString('base64')}`,
        );
      });
    });
  });

  describe('a deployment that only wires one of the two base URLs', (it) => {
    it('still reports on the one it configured', async () => {
      stubProbes({
        [`${GRAFANA_TEST_URL}/api/health`]: 'network-error',
      });
      const found = await monitoringIds({ prometheusBaseUrl: '' });

      expect(found).toContain('monitoring-grafana-unreachable');
      expect(found).not.toContain('monitoring-not-configured');
      expect(found.some((id) => id.startsWith('monitoring-prometheus-'))).toBe(
        false,
      );
    });
  });
});

describe('secret placeholders (PLAN-ConfigCheck-Coverage Phase 2)', (it) => {
  it('reports nothing when node-server says every secret is fine', async () => {
    // Arrange - the top-level `beforeEach` already stubs this cleanly;
    // asserted explicitly here as the baseline the rest of this block spoils.
    const found = await monitoringIds();

    expect(found.some((id) => id.endsWith('-placeholder'))).toBe(false);
  });

  it.each([
    [
      'sessionTokenSigningKeyIsPlaceholder',
      'jwt-secret-placeholder',
      'JWT_SECRET',
    ],
    [
      'sessionManagerServiceApiKeyIsPlaceholder',
      'node-server-key-placeholder',
      'NODE_SERVER_KEY',
    ],
    [
      'nodeServerServiceApiKeyIsPlaceholder',
      'node-server-service-key-placeholder',
      'NODE_SERVER_SERVICE_KEY',
    ],
    [
      'transcriptionServiceApiKeyIsPlaceholder',
      'transcription-api-key-placeholder',
      'TRANSCRIPTION_API_KEY',
    ],
  ] as const)(
    'flags %s as %s, critical in production',
    async (field, expectedId, variable) => {
      stubProbes({
        [CONFIG_AUDIT_URL]: {
          status: 200,
          body: {
            nodeServer: {
              status: 'ok',
              secretPlaceholders: {
                sessionTokenSigningKeyIsPlaceholder: false,
                sessionManagerServiceApiKeyIsPlaceholder: false,
                nodeServerServiceApiKeyIsPlaceholder: false,
                transcriptionServiceApiKeyIsPlaceholder: false,
                [field]: true,
              },
            },
          },
        },
      });

      const report = await monitoringService().check();
      const found = report.findings.find((f) => f.id === expectedId);

      expect(found).toBeTruthy();
      expect(found?.severity).toBe('critical');
      expect(found?.title).toContain(variable);
      // Never a value, only ever the variable name and a classification.
      expect(found?.detail).not.toMatch(/[A-Za-z0-9+/]{16,}/);
    },
  );

  it('is only advisory in development, unlike a real deployment secret', async () => {
    stubProbes({
      [CONFIG_AUDIT_URL]: {
        status: 200,
        body: {
          nodeServer: {
            status: 'ok',
            secretPlaceholders: {
              sessionTokenSigningKeyIsPlaceholder: true,
              sessionManagerServiceApiKeyIsPlaceholder: false,
              nodeServerServiceApiKeyIsPlaceholder: false,
              transcriptionServiceApiKeyIsPlaceholder: false,
            },
          },
        },
      },
    });

    const report = await monitoringService({
      declaredEnv: 'development',
    }).check();
    const found = report.findings.find(
      (f) => f.id === 'jwt-secret-placeholder',
    );

    expect(found?.severity).toBe('advisory');
    expect(found?.productionSeverity).toBe('critical');
  });

  it('reports unavailable, not silence, when the sidecar cannot be reached', async () => {
    stubProbes({ [CONFIG_AUDIT_URL]: 'network-error' });

    const found = await monitoringIds();

    expect(found).toContain('secret-placeholder-audit-unavailable');
  });

  it('reports unavailable when the sidecar answers with a body Config Check cannot parse', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('not json at all', { status: 200 })),
    );

    const found = await monitoringIds();

    expect(found).toContain('secret-placeholder-audit-unavailable');
  });

  // Valid JSON of the wrong shape is the version-skew case - an older or
  // newer sidecar answering 200 - and is the failure mode that matters most,
  // because both bad outcomes are silent: a missing `secretPlaceholders`
  // throws inside `check()`'s `Promise.all` and 500s the whole report, and a
  // present-but-empty one reads every flag as `undefined` and reports a
  // malformed sidecar as a clean deployment. Neither is invalid JSON, so the
  // test above never covered them.
  it.each([
    ['`nodeServer` is missing entirely', {}],
    ['`nodeServer` is not an object', { nodeServer: 'ok' }],
    [
      '`status` is ok but `secretPlaceholders` is missing',
      { nodeServer: { status: 'ok' } },
    ],
    [
      '`secretPlaceholders` is present but empty',
      { nodeServer: { status: 'ok', secretPlaceholders: {} } },
    ],
    [
      '`secretPlaceholders` is missing one field',
      {
        nodeServer: {
          status: 'ok',
          secretPlaceholders: {
            sessionTokenSigningKeyIsPlaceholder: false,
            sessionManagerServiceApiKeyIsPlaceholder: false,
            nodeServerServiceApiKeyIsPlaceholder: false,
          },
        },
      },
    ],
    [
      '`status` is unavailable but `reason` is missing',
      { nodeServer: { status: 'unavailable' } },
    ],
  ])(
    'reports unavailable, and never crashes the report, when %s',
    async (_label, body) => {
      stubProbes({ [CONFIG_AUDIT_URL]: { status: 200, body } });

      const report = await monitoringService().check();
      const found = report.findings.map((f) => f.id);

      expect(found).toContain('secret-placeholder-audit-unavailable');
      expect(found.some((id) => id.endsWith('-placeholder'))).toBe(false);
    },
  );

  it('accepts a body carrying fields this build does not know about', async () => {
    // The other half of version skew: a *newer* sidecar adding a field must
    // not read as unavailable, or upgrading the sidecar first would blind
    // Config Check until admin-server caught up.
    stubProbes({
      [CONFIG_AUDIT_URL]: {
        status: 200,
        body: {
          nodeServer: {
            status: 'ok',
            somethingNew: 42,
            secretPlaceholders: {
              sessionTokenSigningKeyIsPlaceholder: true,
              sessionManagerServiceApiKeyIsPlaceholder: false,
              nodeServerServiceApiKeyIsPlaceholder: false,
              transcriptionServiceApiKeyIsPlaceholder: false,
              someFutureKeyIsPlaceholder: false,
            },
          },
        },
      },
    });

    const found = await monitoringIds();

    expect(found).toContain('jwt-secret-placeholder');
    expect(found).not.toContain('secret-placeholder-audit-unavailable');
  });

  it('says the sidecar answered with an error, not that it timed out, on a non-2xx', async () => {
    stubProbes({ [CONFIG_AUDIT_URL]: { status: 503 } });

    const report = await monitoringService().check();
    const found = report.findings.find(
      (f) => f.id === 'secret-placeholder-audit-unavailable',
    );

    expect(found?.detail).toContain('answered HTTP 503');
    expect(found?.detail).not.toContain('did not answer');
  });

  it('says it timed out when the sidecar does not answer at all', async () => {
    stubProbes({ [CONFIG_AUDIT_URL]: 'network-error' });

    const report = await monitoringService().check();
    const found = report.findings.find(
      (f) => f.id === 'secret-placeholder-audit-unavailable',
    );

    expect(found?.detail).toContain('did not answer within');
  });

  it.each(['disabled', 'unauthorized', 'not-yet-polled'] as const)(
    'reports unavailable, not a clean bill of health, when node-server status is %s',
    async (reason) => {
      stubProbes({
        [CONFIG_AUDIT_URL]: {
          status: 200,
          body: { nodeServer: { status: 'unavailable', reason } },
        },
      });

      const found = await monitoringIds();

      expect(found).toContain('secret-placeholder-audit-unavailable');
      expect(found.some((id) => id.endsWith('-placeholder'))).toBe(false);
    },
  );

  it('is only a warning, never critical, when the audit itself is unavailable', async () => {
    // A missing report is a sidecar/network problem, not proof of a bad
    // secret - it must not read as worse than "cannot currently check".
    stubProbes({ [CONFIG_AUDIT_URL]: 'network-error' });

    const report = await monitoringService().check();
    const found = report.findings.find(
      (f) => f.id === 'secret-placeholder-audit-unavailable',
    );

    expect(found?.severity).toBe('warning');
    expect(found?.productionSeverity).toBe('warning');
  });
});
