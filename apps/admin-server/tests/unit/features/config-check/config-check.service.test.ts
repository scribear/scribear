import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  LATEST_MIGRATION,
  MIGRATION_NAMES,
  type SchemaState,
} from '@scribear/scribear-db';

import type { ConfigCheckConfig } from '#src/server/features/config-check/config-check.service.js';
import {
  ConfigCheckService,
  evaluatePublicOriginCheck,
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
  // Off ("none") by default, like a deployment that never turns on the
  // monitoring profile above - `the backup service` describe block below
  // turns it on with its own overrides.
  backupOffsiteMethod: 'none',
  backupIntervalSeconds: 14_400,
  backupEnabled: true,
  azureTenantId: 'tenant-1',
  azureClientId: 'client-1',
  azureClientSecret: '0b4e8d2a7f16c395',
  azureRedirectUri: 'https://example.edu/api/admin/v1/auth/sso/callback',
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
 * A backup directory with a dump that just landed - so `_checkBackup`'s
 * freshness findings (`backup-none-found`/`backup-stale`) stay quiet in every
 * helper below except `backupService`, which cares about them directly and
 * overrides this.
 */
const FRESH_BACKUP = { newestDumpAgeMs: () => Promise.resolve(0) };

/**
 * A `TestAudioGatewayService` stand-in that reports the feature as unset —
 * `TEST_AUDIO_BASE_URL` empty, matching `CLEAN`'s implicit default — so
 * `_checkTestAudioServiceKey` short-circuits before ever calling
 * `listDevices()`. Every helper below except the dedicated `testAudioService`
 * describe block uses this, the same way they pass `{ enabled: false }` for
 * the monitoring gateways they are not testing.
 */
const TEST_AUDIO_GATEWAY_DISABLED = {
  enabled: false,
  listDevices: () =>
    Promise.reject(
      new Error('listDevices() should not be called while disabled'),
    ),
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
    FRESH_BACKUP as unknown as Args[5],
    TEST_AUDIO_GATEWAY_DISABLED as unknown as Args[6],
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

/** The one gateway method the Config Check calls. */
interface GatewayLike {
  getSchemaStatus: () => Promise<unknown>;
}

/**
 * A Session Manager that answers, and refuses this console's admin key —
 * the only evidence `_checkSessionManagerKey` treats as proof. 401 is what
 * the shared `INVALID_ADMIN_KEY_REPLY_SCHEMA` declares; 403 is covered too
 * because a proxy in front of it may answer that instead.
 */
function rejectingGateway(status: number): GatewayLike {
  return {
    getSchemaStatus: () =>
      Promise.resolve([{ status, data: { code: 'INVALID_ADMIN_KEY' } }, null]),
  };
}

/** A Postgres that is not answering, so `_checkDatabase` short-circuits. */
const UNREACHABLE_DB: DbClientLike = {
  ping: () => Promise.reject(new Error('ECONNREFUSED')),
  hasAdminSchema: () => Promise.resolve(true),
  scribearSchemaState: () => Promise.resolve(CURRENT_SCHEMA),
};

/**
 * A `ConfigCheckService` whose Session Manager gateway is `gw`, so `check()`'s
 * findings include exactly what `_checkSessionManagerKey` made of it.
 */
function keyService(
  gw: GatewayLike,
  overrides: Partial<ConfigCheckConfig> = {},
  dbClient: DbClientLike = REACHABLE_DB,
): ConfigCheckService {
  type Args = ConstructorParameters<typeof ConfigCheckService>;
  return new ConfigCheckService(
    { ...CLEAN, ...overrides },
    { enabled: false } as unknown as Args[1],
    { check: () => Promise.resolve([]) } as unknown as Args[2],
    dbClient as unknown as Args[3],
    gw as unknown as Args[4],
    FRESH_BACKUP as unknown as Args[5],
  );
}

async function keyIds(
  gw: GatewayLike,
  overrides: Partial<ConfigCheckConfig> = {},
  dbClient: DbClientLike = REACHABLE_DB,
): Promise<string[]> {
  const report = await keyService(gw, overrides, dbClient).check();
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
    FRESH_BACKUP as unknown as Args[5],
    TEST_AUDIO_GATEWAY_DISABLED as unknown as Args[6],
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
    FRESH_BACKUP as unknown as Args[5],
    TEST_AUDIO_GATEWAY_DISABLED as unknown as Args[6],
  );
}

async function monitoringIds(
  overrides: Partial<ConfigCheckConfig> = {},
): Promise<string[]> {
  const report = await monitoringService(overrides).check();
  return report.findings.map((f) => f.id);
}

/** What `backupDirectoryService.newestDumpAgeMs()` returns. */
interface BackupDirectoryLike {
  newestDumpAgeMs: () => Promise<number | null>;
}

/**
 * A `ConfigCheckService` with every other dependency healthy, so `check()`'s
 * `backup-*` findings are exactly what `_checkBackup` made of `overrides` and
 * `backupDirectory`.
 */
function backupService(
  overrides: Partial<ConfigCheckConfig> = {},
  backupDirectory: BackupDirectoryLike = FRESH_BACKUP,
): ConfigCheckService {
  type Args = ConstructorParameters<typeof ConfigCheckService>;
  return new ConfigCheckService(
    { ...CLEAN, ...overrides },
    { enabled: false } as unknown as Args[1],
    { check: () => Promise.resolve([]) } as unknown as Args[2],
    REACHABLE_DB as unknown as Args[3],
    gateway(LATEST_MIGRATION) as unknown as Args[4],
    backupDirectory as unknown as Args[5],
    TEST_AUDIO_GATEWAY_DISABLED as unknown as Args[6],
  );
}

async function backupIds(
  overrides: Partial<ConfigCheckConfig> = {},
  backupDirectory?: BackupDirectoryLike,
): Promise<string[]> {
  const report = await backupService(overrides, backupDirectory).check();
  return report.findings.map((f) => f.id);
}

async function backupFindings(
  overrides: Partial<ConfigCheckConfig> = {},
  backupDirectory?: BackupDirectoryLike,
) {
  const report = await backupService(overrides, backupDirectory).check();
  return report.findings.filter((f) => f.category === 'backups');
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

  // `isPlaceholder('')` is false, and the placeholder loop skips everything
  // that is not a placeholder, so an unset secret used to produce no finding
  // at all — silence indistinguishable from a well-configured deployment.
  describe('secrets that are not set at all', (it) => {
    it.each([
      ['adminApiKey', 'admin-api-key-missing'],
      ['dbPassword', 'db-password-missing'],
    ] as const)('are caught for %s', (field, expectedId) => {
      expect(ids({ [field]: '' })).toContain(expectedId);
    });

    it('says "not set", never "still the placeholder"', () => {
      const [found] = check({ adminApiKey: '' }).filter(
        (f) => f.id === 'admin-api-key-missing',
      );

      expect(found?.detail).toContain('not set');
      expect(found?.detail).not.toContain('placeholder');
    });

    // The two mistakes are different mistakes, and each gets exactly one
    // finding: an empty secret must not also be reported as a placeholder,
    // and a placeholder must not also be reported as missing.
    it.each([
      ['', 'admin-api-key-missing', 'admin-api-key-placeholder'],
      ['CHANGEME', 'admin-api-key-placeholder', 'admin-api-key-missing'],
    ] as const)(
      'reports %s as %s and not as %s',
      (value, expectedId, notExpectedId) => {
        const found = ids({ adminApiKey: value });

        expect(found).toContain(expectedId);
        expect(found).not.toContain(notExpectedId);
      },
    );

    it('is critical for ADMIN_API_KEY in every environment', () => {
      const [found] = check({
        declaredEnv: 'development',
        isDevelopment: true,
        adminApiKey: '',
      }).filter((f) => f.id === 'admin-api-key-missing');

      // A console that cannot reach session-manager is equally broken on a
      // laptop; unlike a weak secret, this is not a hardening nit that a dev
      // box gets to ignore.
      expect(found?.severity).toBe('critical');
      expect(found?.productionSeverity).toBe('critical');
    });

    // A dev Postgres on `trust` authentication genuinely works with no
    // password, so this one is graded down in development and not elsewhere.
    it('is only a warning for DB_PASSWORD in development', () => {
      const [found] = check({
        declaredEnv: 'development',
        isDevelopment: true,
        dbPassword: '',
      }).filter((f) => f.id === 'db-password-missing');

      expect(found?.severity).toBe('warning');
      expect(found?.productionSeverity).toBe('critical');
    });

    // Deliberate absences, pinned so a later edit has to argue with a test
    // rather than quietly add a finding that fires on healthy deployments.
    it('says nothing statically about an empty TEST_AUDIO_SERVICE_KEY', () => {
      // Its peer fails closed and names the variable itself, and whether the
      // two agree is answerable by calling the generator - better evidence
      // than a string comparison, and a separate check.
      expect(ids({ testAudioServiceKey: '' })).toStrictEqual([]);
    });

    it('reports an empty ADMIN_SESSION_SECRET once, by its own finding', () => {
      const found = ids({ adminSessionSecret: '' });

      expect(found).toStrictEqual(['admin-session-secret-missing']);
    });

    it('reports nothing when every secret is set', () => {
      expect(ids()).toStrictEqual([]);
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

  describe('the local admin password', (it) => {
    // CLEAN's own `adminLocalCredentials` password half is 16 characters —
    // "healthy" for every test in this block that does not override it.
    it('accepts a password at or above the 8-character minimum', () => {
      const found = ids({ adminLocalCredentials: 'engrit 8charmin' });
      expect(found).not.toContain('admin-local-credentials-weak');
      expect(found).not.toContain('admin-local-credentials-malformed');
    });

    it('flags a password shorter than 8 characters', () => {
      expect(ids({ adminLocalCredentials: 'engrit 1234567' })).toContain(
        'admin-local-credentials-weak',
      );
    });

    it('flags the one-character password the placeholder check alone would pass', () => {
      // The motivating case: `x` contains no placeholder marker, so
      // `admin-local-credentials-placeholder` stays quiet on its own.
      const found = ids({ adminLocalCredentials: 'engrit x' });
      expect(found).not.toContain('admin-local-credentials-placeholder');
      expect(found).toContain('admin-local-credentials-weak');
    });

    it('does not flag a password of exactly 8 characters', () => {
      expect(ids({ adminLocalCredentials: 'engrit exactly8' })).not.toContain(
        'admin-local-credentials-weak',
      );
    });

    it('is a warning in staging but blocks production, like the session secret', () => {
      const [found] = check({
        declaredEnv: 'staging',
        adminLocalCredentials: 'engrit short',
      }).filter((f) => f.id === 'admin-local-credentials-weak');

      expect(found?.severity).toBe('warning');
      expect(found?.productionSeverity).toBe('critical');
    });

    it('flags a value with no space as malformed, not as a zero-length password', () => {
      const found = ids({ adminLocalCredentials: 'nopasswordhere' });
      expect(found).toContain('admin-local-credentials-malformed');
      expect(found).not.toContain('admin-local-credentials-weak');
    });

    it('flags a trailing space (empty password) as malformed', () => {
      expect(ids({ adminLocalCredentials: 'engrit ' })).toContain(
        'admin-local-credentials-malformed',
      );
    });

    it('flags a leading space (empty username) as malformed', () => {
      expect(ids({ adminLocalCredentials: ' engritpassword' })).toContain(
        'admin-local-credentials-malformed',
      );
    });

    it('does not flag an absent (login disabled) credential', () => {
      const found = ids({
        adminLocalCredentials: '',
        // CLEAN's Azure vars are already all set, so this stays a clean
        // SSO-only deployment rather than also tripping no-login-method.
      });
      expect(found).not.toContain('admin-local-credentials-weak');
      expect(found).not.toContain('admin-local-credentials-malformed');
    });

    // One mistake, one finding: a value that already reads as the example
    // placeholder is reported once, by the placeholder check, not a second
    // time here as "too short" — mirrors the session-secret guard above.
    it('does not also flag a placeholder value as weak, even when the parsed password is short', () => {
      const found = ids({ adminLocalCredentials: 'CHANGEMEuser yz' });
      expect(found).toContain('admin-local-credentials-placeholder');
      expect(found).not.toContain('admin-local-credentials-weak');
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

    // Regression test: `no-login-method` used to check the loose 3-of-5-var
    // `ssoConfigured` instead of mirroring `isEnabled()`'s 5-var requirement,
    // so a deployment with local login off and SSO merely "started" (not
    // actually functional) read as having a working login method. It did not.
    it('flags a deployment nobody can sign in to when SSO is only partially configured', () => {
      expect(
        ids({
          adminLocalCredentials: '',
          azureRedirectUri: '',
          allowedGroup: '',
        }),
      ).toContain('no-login-method');
    });

    it('does not flag no-login-method when SSO is fully configured', () => {
      expect(
        ids({ adminLocalCredentials: '' }), // CLEAN's Azure vars are all set
      ).not.toContain('no-login-method');
    });

    it('flags an incomplete SSO configuration missing more than just the group', () => {
      const found = ids({ azureRedirectUri: '' });
      expect(found).toContain('sso-incomplete-config');
      expect(found).not.toContain('no-login-method'); // local login still covers access
    });

    it('names every missing variable in the incomplete-config finding', () => {
      const [finding] = check({
        azureRedirectUri: '',
        allowedGroup: '',
      }).filter((f) => f.id === 'sso-incomplete-config');
      expect(finding?.detail).toContain('AZURE_REDIRECT_URI');
      expect(finding?.detail).toContain('ADMIN_ALLOWED_GROUP');
    });

    it('does not flag sso-incomplete-config when ADMIN_ALLOWED_GROUP is the only thing missing', () => {
      // sso-no-group-restriction already reports this specific, more
      // actionable case - firing both would name the same root cause twice.
      const found = ids({ allowedGroup: '' });
      expect(found).toContain('sso-no-group-restriction');
      expect(found).not.toContain('sso-incomplete-config');
    });

    it('does not flag sso-incomplete-config when no Azure vars are set at all', () => {
      // Not "started and broken" - just "not configured yet", already
      // covered by no-login-method/local-login-only as appropriate.
      const found = ids({
        azureTenantId: '',
        azureClientId: '',
        azureClientSecret: '',
        azureRedirectUri: '',
        allowedGroup: '',
      });
      expect(found).not.toContain('sso-incomplete-config');
    });

    it('does not flag sso-incomplete-config when all five vars are set', () => {
      expect(ids({})).not.toContain('sso-incomplete-config');
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

describe('evaluatePublicOriginCheck', (it) => {
  const idsFor = (host: string): string[] =>
    evaluatePublicOriginCheck(host, 'production').map((f) => f.id);

  it('flags localhost', () => {
    expect(idsFor('localhost')).toContain(
      'public-origin-not-externally-resolvable',
    );
  });

  it('flags a loopback IPv4 literal', () => {
    expect(idsFor('127.0.0.1')).toContain(
      'public-origin-not-externally-resolvable',
    );
  });

  it.each(['10.1.2.3', '172.16.0.5', '172.31.255.255', '192.168.1.1'])(
    'flags the private IPv4 address %s',
    (host) => {
      expect(idsFor(host)).toContain('public-origin-not-externally-resolvable');
    },
  );

  it('does not flag a public-looking IPv4 address', () => {
    // 172.32.x is outside the 172.16/12 RFC1918 block by one - a real
    // boundary check, not just "starts with 172".
    expect(idsFor('172.32.0.1')).toEqual([]);
  });

  it('flags a link-local IPv4 address', () => {
    expect(idsFor('169.254.1.1')).toContain(
      'public-origin-not-externally-resolvable',
    );
  });

  it('flags an IPv6 loopback literal', () => {
    expect(idsFor('::1')).toContain('public-origin-not-externally-resolvable');
  });

  it('flags an IPv6 unique-local address', () => {
    expect(idsFor('fd12:3456:789a::1')).toContain(
      'public-origin-not-externally-resolvable',
    );
  });

  it('flags a bare single-label hostname (Compose service name shape)', () => {
    expect(idsFor('admin-server')).toContain(
      'public-origin-not-externally-resolvable',
    );
  });

  it('flags a .local mDNS name', () => {
    expect(idsFor('my-laptop.local')).toContain(
      'public-origin-not-externally-resolvable',
    );
  });

  it('does not flag a normal-looking public FQDN', () => {
    // Cannot be *confirmed* reachable from admin-server's position (see the
    // function's own doc) - only "not ruled out", which is silence.
    expect(idsFor('scribear.example.edu')).toEqual([]);
  });

  it('does not flag a public IPv4 address', () => {
    expect(idsFor('8.8.8.8')).toEqual([]);
  });

  it('reports nothing for an empty hostname', () => {
    expect(idsFor('')).toEqual([]);
  });

  it('is advisory in development but blocks production', () => {
    const [found] = evaluatePublicOriginCheck('localhost', 'staging').filter(
      (f) => f.id === 'public-origin-not-externally-resolvable',
    );
    expect(found?.severity).toBe('critical');
    expect(found?.productionSeverity).toBe('critical');

    const [devFound] = evaluatePublicOriginCheck(
      'localhost',
      'development',
    ).filter((f) => f.id === 'public-origin-not-externally-resolvable');
    expect(devFound?.severity).toBe('advisory');
  });

  it('names the offending host in the detail', () => {
    const [found] = evaluatePublicOriginCheck('localhost', 'production');
    expect(found?.detail).toContain('localhost');
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
      it('fires critical in every environment when admin/CHANGEME is accepted', async () => {
        stubProbes({
          ...MONITORING_HEALTHY,
          [`${GRAFANA_TEST_URL}/api/org`]: { status: 200 },
        });
        const prodReport = await monitoringService().check();
        const prodFound = prodReport.findings.find(
          (f) => f.id === 'monitoring-grafana-default-password',
        );
        expect(prodFound).toBeTruthy();
        expect(prodFound?.severity).toBe('critical');

        // Now also critical in development: Grafana is proxied through nginx at
        // /grafana/ (onsite/VPN-reachable, not just loopback) and has no
        // brute-force lockout, so CHANGEME is a real exposure even on a dev box.
        const devReport = await monitoringService({
          declaredEnv: 'development',
          isDevelopment: true,
        }).check();
        const devFound = devReport.findings.find(
          (f) => f.id === 'monitoring-grafana-default-password',
        );
        expect(devFound).toBeTruthy();
        expect(devFound?.severity).toBe('critical');
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

/** What `TestAudioGatewayService.listDevices()` can resolve to. */
type TestAudioResultLike =
  | { kind: 'response'; status: number; body?: unknown }
  | { kind: 'unparseable'; status: number }
  | { kind: 'unreachable'; err: unknown };

/**
 * A `ConfigCheckService` with a stand-in `TestAudioGatewayService`: `enabled`
 * mirrors `TEST_AUDIO_BASE_URL` being set, and `listDevices()` resolves to
 * `result` exactly once — every other dependency is healthy, so `check()`'s
 * findings are exactly what `_checkTestAudioServiceKey` made of `result`.
 */
function testAudioService(
  enabled: boolean,
  result: TestAudioResultLike,
  overrides: Partial<ConfigCheckConfig> = {},
): ConfigCheckService {
  type Args = ConstructorParameters<typeof ConfigCheckService>;
  const gatewayStub = {
    enabled,
    listDevices: () => Promise.resolve(result),
  };
  return new ConfigCheckService(
    { ...CLEAN, ...overrides },
    { enabled: false } as unknown as Args[1],
    { check: () => Promise.resolve([]) } as unknown as Args[2],
    REACHABLE_DB as unknown as Args[3],
    gateway(LATEST_MIGRATION) as unknown as Args[4],
    FRESH_BACKUP as unknown as Args[5],
    gatewayStub as unknown as Args[6],
  );
}

async function testAudioIds(
  enabled: boolean,
  result: TestAudioResultLike,
  overrides: Partial<ConfigCheckConfig> = {},
): Promise<string[]> {
  const report = await testAudioService(enabled, result, overrides).check();
  return report.findings.map((f) => f.id);
}

describe('the test audio service key probe', (it) => {
  it('does not probe at all when TEST_AUDIO_BASE_URL is unset', async () => {
    // `enabled: false` here stands for "TEST_AUDIO_BASE_URL is empty" -
    // `listDevices()` on this stub would reject if ever called, so a passing
    // test also proves the probe was skipped, not merely that its result
    // produced no finding.
    const found = await testAudioIds(false, {
      kind: 'unreachable',
      err: new Error('should not be called'),
    });
    expect(found.some((id) => id.startsWith('test-audio-service-key-'))).toBe(
      false,
    );
  });

  it('reports nothing when the key is accepted', async () => {
    const found = await testAudioIds(true, {
      kind: 'response',
      status: 200,
      body: { devices: [] },
    });
    expect(found.some((id) => id.startsWith('test-audio-service-key-'))).toBe(
      false,
    );
  });

  it('flags a rejected key (wrong, not placeholder) as a mismatch, not a pass', async () => {
    const found = await testAudioIds(true, {
      kind: 'response',
      status: 401,
      body: {},
    });
    expect(found).toContain('test-audio-service-key-mismatch');
  });

  it('also flags a 403 as a mismatch', async () => {
    const found = await testAudioIds(true, {
      kind: 'response',
      status: 403,
      body: {},
    });
    expect(found).toContain('test-audio-service-key-mismatch');
  });

  it('is critical in staging and production, unlike a probe that could not run', async () => {
    const [found] = (
      await testAudioService(true, {
        kind: 'response',
        status: 401,
        body: {},
      }).check()
    ).findings.filter((f) => f.id === 'test-audio-service-key-mismatch');
    expect(found?.severity).toBe('critical');
  });

  it('reports "could not verify" - not a pass - when the generator is unreachable', async () => {
    const found = await testAudioIds(true, {
      kind: 'unreachable',
      err: new Error('connect ECONNREFUSED'),
    });
    expect(found).toContain('test-audio-service-key-probe-unavailable');
    expect(found).not.toContain('test-audio-service-key-mismatch');
  });

  it('reports "could not verify" when the response body is unparseable', async () => {
    const found = await testAudioIds(true, {
      kind: 'unparseable',
      status: 200,
    });
    expect(found).toContain('test-audio-service-key-probe-unavailable');
  });

  it('reports "could not verify" on an unexpected status, not a pass', async () => {
    const found = await testAudioIds(true, {
      kind: 'response',
      status: 500,
      body: {},
    });
    expect(found).toContain('test-audio-service-key-probe-unavailable');
  });

  it('the "could not verify" finding is only a warning, never critical', async () => {
    const [found] = (
      await testAudioService(true, {
        kind: 'unreachable',
        err: new Error('timeout'),
      }).check()
    ).findings.filter(
      (f) => f.id === 'test-audio-service-key-probe-unavailable',
    );
    expect(found?.severity).toBe('warning');
    expect(found?.productionSeverity).toBe('warning');
  });

  it('does not probe when the key is still the example placeholder', async () => {
    // Already reported by the static placeholder check - probing would
    // either bury it under a second finding or, worse, read as "verified"
    // if the generator happens to hold the same placeholder.
    const found = await testAudioIds(
      true,
      { kind: 'unreachable', err: new Error('should not be called') },
      { testAudioServiceKey: 'CHANGEME' },
    );
    expect(found).toContain('test-audio-service-key-placeholder');
    expect(found.some((id) => id.startsWith('test-audio-service-key-'))).toBe(
      true, // only the placeholder finding, none of the probe's own ids
    );
    expect(found).not.toContain('test-audio-service-key-mismatch');
    expect(found).not.toContain('test-audio-service-key-probe-unavailable');
  });
});

describe('the backup service (compose.yml v12)', (it) => {
  describe('BACKUP_ENABLED=false', (it) => {
    it('reports one advisory finding instead of any freshness or offsite finding', async () => {
      const found = await backupFindings(
        { backupEnabled: false, backupOffsiteMethod: 'none' },
        { newestDumpAgeMs: () => Promise.resolve(null) },
      );

      expect(found.map((f) => f.id)).toEqual(['backup-disabled']);
      expect(found[0]?.severity).toBe('advisory');
      expect(found[0]?.productionSeverity).toBe('advisory');
    });

    it('never asks the backup directory anything', async () => {
      const newestDumpAgeMs = vi.fn(() => Promise.resolve(0));
      await backupIds({ backupEnabled: false }, { newestDumpAgeMs });

      expect(newestDumpAgeMs).not.toHaveBeenCalled();
    });
  });

  describe('off-host copy', (it) => {
    it('is only advisory in development, warning in production', async () => {
      const found = await backupFindings({ backupOffsiteMethod: 'none' });
      const offsite = found.find(
        (f) => f.id === 'backup-offsite-not-configured',
      );

      expect(offsite).toBeTruthy();
      expect(offsite?.productionSeverity).toBe('warning');
    });

    it('reports nothing when scp or rsync is configured', async () => {
      const scp = await backupIds({ backupOffsiteMethod: 'scp' });
      const rsync = await backupIds({ backupOffsiteMethod: 'rsync' });

      expect(scp).not.toContain('backup-offsite-not-configured');
      expect(rsync).not.toContain('backup-offsite-not-configured');
    });
  });

  describe('freshness', (it) => {
    it('reports nothing when a backup just landed', async () => {
      const found = await backupIds(
        { backupOffsiteMethod: 'scp' },
        { newestDumpAgeMs: () => Promise.resolve(0) },
      );

      expect(found.filter((id) => id.startsWith('backup-'))).toEqual([]);
    });

    it('flags none found without also calling it stale', async () => {
      const found = await backupIds(
        { backupOffsiteMethod: 'scp' },
        { newestDumpAgeMs: () => Promise.resolve(null) },
      );

      expect(found).toContain('backup-none-found');
      expect(found).not.toContain('backup-stale');
    });

    it('accepts a backup within the interval plus an hour of grace', async () => {
      const found = await backupIds(
        { backupOffsiteMethod: 'scp', backupIntervalSeconds: 14_400 },
        // Interval + grace exactly: still fresh, since the threshold is
        // exclusive - one tick later is what "stale" tests.
        { newestDumpAgeMs: () => Promise.resolve((14_400 + 3600) * 1000) },
      );

      expect(found).not.toContain('backup-stale');
    });

    it('flags a backup older than the interval plus an hour of grace as critical in staging/production', async () => {
      const found = await backupFindings(
        { backupOffsiteMethod: 'scp', backupIntervalSeconds: 14_400 },
        { newestDumpAgeMs: () => Promise.resolve((14_400 + 3600) * 1000 + 1) },
      );
      const stale = found.find((f) => f.id === 'backup-stale');

      expect(stale?.severity).toBe('critical');
      expect(stale?.detail).toContain('14400s');
    });

    it('is only a warning in development', async () => {
      const found = await backupFindings(
        {
          backupOffsiteMethod: 'scp',
          isDevelopment: true,
          declaredEnv: 'development',
        },
        { newestDumpAgeMs: () => Promise.resolve(999_999_999) },
      );
      const stale = found.find((f) => f.id === 'backup-stale');

      expect(stale?.severity).toBe('warning');
      expect(stale?.productionSeverity).toBe('critical');
    });
  });

  it('never names db-backup findings outside the backups category', async () => {
    const found = await backupFindings(
      { backupOffsiteMethod: 'none' },
      { newestDumpAgeMs: () => Promise.resolve(null) },
    );

    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(f.category).toBe('backups');
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

  it.each(['disabled', 'not-yet-polled', 'unreachable'] as const)(
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
    stubProbes({
      [CONFIG_AUDIT_URL]: {
        status: 200,
        body: { nodeServer: { status: 'unavailable', reason: 'unreachable' } },
      },
    });

    const report = await monitoringService().check();
    const found = report.findings.find(
      (f) => f.id === 'secret-placeholder-audit-unavailable',
    );

    expect(found?.severity).toBe('warning');
    expect(found?.productionSeverity).toBe('warning');
  });
});

// PLAN-VisibleErrors §7.2.5. Previously inferable only as a side effect of
// `secret-placeholder-audit-unavailable`, which named node-server - the wrong
// subject - for a fault in a service the health rollup does not probe at all.
describe('the monitoring sidecar being down', (it) => {
  it('is its own finding, not a shade of the secret audit', async () => {
    stubProbes({ [CONFIG_AUDIT_URL]: 'network-error' });

    const found = await monitoringIds();

    expect(found).toContain('monitoring-sidecar-unreachable');
    expect(found).not.toContain('secret-placeholder-audit-unavailable');
  });

  it('never reads as "the secrets are fine"', async () => {
    // The discipline the alerts panel adopted: "nothing to report" and "we
    // could not ask" must not be the same answer.
    stubProbes({ [CONFIG_AUDIT_URL]: 'network-error' });

    const found = await monitoringIds();

    expect(found.some((id) => id.endsWith('-placeholder'))).toBe(false);
    expect(found).not.toContain('node-server-service-key-mismatch');
  });

  it('says what went unchecked, including the key-agreement pair', async () => {
    stubProbes({ [CONFIG_AUDIT_URL]: 'network-error' });

    const report = await monitoringService().check();
    const found = report.findings.find(
      (f) => f.id === 'monitoring-sidecar-unreachable',
    );

    expect(found?.detail).toContain('NODE_SERVER_SERVICE_KEY');
    expect(found?.detail).toContain('alerts');
  });

  it('says it timed out when the sidecar does not answer at all', async () => {
    stubProbes({ [CONFIG_AUDIT_URL]: 'network-error' });

    const report = await monitoringService().check();
    const found = report.findings.find(
      (f) => f.id === 'monitoring-sidecar-unreachable',
    );

    expect(found?.detail).toContain('did not answer within');
  });

  it('says the sidecar answered with an error, not that it timed out, on a non-2xx', async () => {
    stubProbes({ [CONFIG_AUDIT_URL]: { status: 503 } });

    const report = await monitoringService().check();
    const found = report.findings.find(
      (f) => f.id === 'monitoring-sidecar-unreachable',
    );

    expect(found?.detail).toContain('answered HTTP 503');
    expect(found?.detail).not.toContain('did not answer');
  });

  it('is a warning, never critical: it is an outage, not proof of a bad secret', async () => {
    stubProbes({ [CONFIG_AUDIT_URL]: 'network-error' });

    const report = await monitoringService().check();
    const found = report.findings.find(
      (f) => f.id === 'monitoring-sidecar-unreachable',
    );

    expect(found?.severity).toBe('warning');
    expect(found?.productionSeverity).toBe('warning');
  });

  it('stays quiet when the sidecar answers', async () => {
    const found = await monitoringIds();

    expect(found).not.toContain('monitoring-sidecar-unreachable');
  });
});

// PLAN-VisibleErrors §7.2.3. Two non-placeholder keys that simply differ are
// invisible to every placeholder check in this file, and produce a deployment
// that looks green and does not work.
describe('cross-service key agreement', () => {
  describe('monitoring-sidecar and node-server (NODE_SERVER_SERVICE_KEY)', (it) => {
    /** node-server answered the sidecar's poll 401/403. */
    const REJECTED = {
      status: 200,
      body: { nodeServer: { status: 'unavailable', reason: 'unauthorized' } },
    };

    it('names the pair when node-server rejects the sidecar', async () => {
      stubProbes({ [CONFIG_AUDIT_URL]: REJECTED });

      const found = await monitoringIds();

      expect(found).toContain('node-server-service-key-mismatch');
    });

    // The whole point of the finding: `unauthorized` used to be reported as
    // one more way of not knowing, when it is the opposite - a proof about
    // two configuration values.
    it('does not also report the audit as merely unavailable', async () => {
      stubProbes({ [CONFIG_AUDIT_URL]: REJECTED });

      const found = await monitoringIds();

      expect(found).not.toContain('secret-placeholder-audit-unavailable');
    });

    it('names both containers and the exact variable', async () => {
      stubProbes({ [CONFIG_AUDIT_URL]: REJECTED });

      const report = await monitoringService().check();
      const found = report.findings.find(
        (f) => f.id === 'node-server-service-key-mismatch',
      );

      expect(found?.title).toContain('NODE_SERVER_SERVICE_KEY');
      expect(found?.title).toContain('monitoring-sidecar');
      expect(found?.title).toContain('node-server');
      // The next action has to name both containers: recreating one is what
      // leaves them disagreeing.
      expect(found?.remediation).toContain('node-server monitoring-sidecar');
    });

    it('blocks promotion to production without being critical in a dev box', async () => {
      stubProbes({ [CONFIG_AUDIT_URL]: REJECTED });

      const report = await monitoringService({
        declaredEnv: 'development',
      }).check();
      const found = report.findings.find(
        (f) => f.id === 'node-server-service-key-mismatch',
      );

      expect(found?.severity).toBe('advisory');
      expect(found?.productionSeverity).toBe('critical');
    });

    it('stays quiet when the poll succeeds', async () => {
      const found = await monitoringIds();

      expect(found).not.toContain('node-server-service-key-mismatch');
    });

    // An unreachable sidecar cannot vouch for this pair either way, and the
    // silence must not read as agreement - `monitoring-sidecar-unreachable`
    // is what says so.
    it('is neither claimed nor denied when the sidecar is unreachable', async () => {
      stubProbes({ [CONFIG_AUDIT_URL]: 'network-error' });

      const found = await monitoringIds();

      expect(found).not.toContain('node-server-service-key-mismatch');
      expect(found).toContain('monitoring-sidecar-unreachable');
    });
  });

  describe('admin-server and session-manager (SESSION_MANAGER_API_KEY)', (it) => {
    it.each([401, 403])(
      'names the pair when session-manager answers %i',
      async (status) => {
        const found = await keyIds(rejectingGateway(status));

        expect(found).toContain('session-manager-admin-key-mismatch');
      },
    );

    it('names both containers, the variable, and what an operator sees', async () => {
      const report = await keyService(rejectingGateway(401)).check();
      const found = report.findings.find(
        (f) => f.id === 'session-manager-admin-key-mismatch',
      );

      expect(found?.title).toContain('SESSION_MANAGER_API_KEY');
      expect(found?.title).toContain('admin-server');
      expect(found?.title).toContain('session-manager');
      expect(found?.detail).toContain('BACKEND_MISCONFIGURATION');
      expect(found?.remediation).toContain('admin-server session-manager');
      expect(found?.severity).toBe('critical');
      // The one secret this finding is about is one admin-server actually
      // holds, so the disclosure rule is checked against the value itself
      // rather than against a shape.
      expect(found?.detail).not.toContain(CLEAN.adminApiKey);
      expect(found?.remediation).not.toContain(CLEAN.adminApiKey);
    });

    it('stays quiet when session-manager accepts the key', async () => {
      const found = await keyIds(gateway(LATEST_MIGRATION));

      expect(found).not.toContain('session-manager-admin-key-mismatch');
    });

    // A service that did not answer is not evidence about a key, and
    // `services-unreachable` already reports it. Two findings for one cause
    // is the pattern this page avoids.
    it('stays quiet when session-manager did not answer at all', async () => {
      const found = await keyIds(gateway(null));

      expect(found).not.toContain('session-manager-admin-key-mismatch');
    });

    it('stays quiet when the gateway throws', async () => {
      const found = await keyIds({
        getSchemaStatus: () => Promise.reject(new Error('timed out')),
      });

      expect(found).not.toContain('session-manager-admin-key-mismatch');
    });

    // An unset key is a different sentence with a different fix, and
    // `admin-api-key-missing` already says it.
    it('defers to admin-api-key-missing when the key is not set at all', async () => {
      const found = await keyIds(rejectingGateway(401), { adminApiKey: '' });

      expect(found).toContain('admin-api-key-missing');
      expect(found).not.toContain('session-manager-admin-key-mismatch');
    });

    // Not folded into `_checkSharedSchemaVersion`, which makes the same call
    // but only after `dbClient.ping()` succeeds: a deployment with both
    // faults most needs to be told they are separate.
    it('is reported even when Postgres is down', async () => {
      const found = await keyIds(rejectingGateway(401), {}, UNREACHABLE_DB);

      expect(found).toContain('database-unreachable');
      expect(found).toContain('session-manager-admin-key-mismatch');
    });
  });
});
