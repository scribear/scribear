import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/**
 * How bad a finding is *in the environment being checked*.
 *
 * - `critical` — insecure or broken as it stands. In production this is
 *   "stop and fix"; the same underlying fact can be harmless in development.
 * - `warning` — works, but not to a standard you want in front of real users.
 * - `advisory` — a deliberate choice worth surfacing, usually an optional
 *   feature left switched off. Not a defect.
 * - `ok` — checked, nothing to say.
 */
export type CheckSeverity = 'critical' | 'warning' | 'advisory' | 'ok';

export type DeploymentEnv = 'development' | 'staging' | 'production';

export type CheckCategory =
  | 'secrets'
  | 'access'
  | 'telemetry'
  | 'services'
  | 'environment';

/**
 * Severity of one finding in each environment.
 *
 * Every check states all three rather than a single level plus a fudge factor,
 * because the interesting cases genuinely differ in kind and not just degree: a
 * placeholder admin password is *correct* in a dev container that is thrown
 * away hourly, and a total compromise in production. Encoding all three is also
 * what lets the console answer the question an operator actually has before a
 * promotion — "what about this deployment would be unacceptable in
 * production?" — without them having to re-run anything.
 */
interface SeverityByEnv {
  development: CheckSeverity;
  staging: CheckSeverity;
  production: CheckSeverity;
}

export interface ConfigFinding {
  /** Stable slug. Safe to link to, and to suppress against later. */
  id: string;
  category: CheckCategory;
  /** One line, stating the fact rather than the fix. */
  title: string;
  /** Severity in the environment that was checked. */
  severity: CheckSeverity;
  /**
   * Severity the same finding would carry in production. Equal to `severity`
   * when the checked environment *is* production. This is the field that makes
   * a staging report predictive rather than merely descriptive.
   */
  productionSeverity: CheckSeverity;
  /** What was found. Never contains a secret value — see `describeSecret`. */
  detail: string;
  /** What to do about it, naming the exact variable and file. */
  remediation?: string | undefined;
  /**
   * Deep link to the relevant deployment wiki page, shown next to the
   * remediation. Set for findings where the fix is a documented setup step
   * (configuring or reaching a dependency) rather than a one-line edit.
   */
  docUrl?: string | undefined;
}

/** Deployment wiki, with per-section anchors used by `docUrl`. */
const WIKI = 'https://github.com/scribear/scribear/wiki';
const DOC = {
  deployment: `${WIKI}/Deployment`,
  postgres: `${WIKI}/Deployment#postgres`,
  migrations: `${WIKI}/Deployment#3-run-database-migrations`,
  redis: `${WIKI}/Deployment#redis`,
} as const;

export interface ConfigCheckReport {
  environment: DeploymentEnv;
  /**
   * `explicit` when `DEPLOYMENT_ENV` said so, `inferred` when it was unset and
   * the environment was deduced. Shown in the UI because every severity on the
   * page is relative to it, and an operator reading a report generated under a
   * wrong assumption should be able to see that at a glance.
   */
  environmentSource: 'explicit' | 'inferred';
  findings: ConfigFinding[];
  summary: Record<CheckSeverity, number>;
  /**
   * Findings that are `critical` in production, whatever they are here. The
   * headline number for a staging deployment about to be promoted.
   */
  blockingForProduction: number;
  checkedAt: string;
}

/**
 * Everything the check inspects, gathered by `AppConfig` so this service never
 * reads `process.env` itself and can be tested by construction.
 *
 * Secret *values* are passed in because classifying them requires them. They
 * never leave this process: every finding reports a classification, and
 * `describeSecret` is the only thing that turns a secret into prose.
 */
export interface ConfigCheckConfig {
  declaredEnv: string;
  /** True when the server was started with `--dev`. */
  isDevelopment: boolean;
  adminApiKey: string;
  adminSessionSecret: string;
  adminLocalCredentials: string;
  dbHost: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  redisUrl: string;
  azureTenantId: string;
  azureClientId: string;
  azureClientSecret: string;
  allowedGroup: string;
}

const PLACEHOLDER_MARKER = 'CHANGEME';

/** Matches the stub marker as a substring — see `assertNotPlaceholderKey`. */
function isPlaceholder(value: string): boolean {
  return value.toUpperCase().includes(PLACEHOLDER_MARKER);
}

/**
 * Describes a secret without disclosing it.
 *
 * This endpoint is authenticated, but "authenticated" and "cleared to read
 * every credential in the deployment" are different things, and a config report
 * is exactly the sort of page that gets screenshotted into a ticket. Callers
 * get a classification and a length; never a prefix, a suffix, or a hash, since
 * a prefix is directly useful to an attacker and a hash of a short secret is
 * merely a slower way of disclosing it.
 */
function describeSecret(value: string): string {
  if (value === '') return 'not set';
  if (isPlaceholder(value))
    return `still the deployment/.env.example placeholder (${String(value.length)} chars)`;
  return `set (${String(value.length)} chars)`;
}

/** Resolves a per-environment severity table against the checked environment. */
function finding(
  base: Omit<ConfigFinding, 'severity' | 'productionSeverity'>,
  severities: SeverityByEnv,
  env: DeploymentEnv,
): ConfigFinding {
  return {
    ...base,
    severity: severities[env],
    productionSeverity: severities.production,
  };
}

/**
 * Resolves the environment the report is relative to.
 *
 * An unset `DEPLOYMENT_ENV` infers **production** unless the server was started
 * with `--dev`. That asymmetry is the whole point: this variable is new, so
 * every deployment that predates it has it unset, and the two possible mistakes
 * are not symmetric. Assuming development would greet a real deployment with a
 * page of reassuring green while its admin password was still `CHANGEME`;
 * assuming production shows a developer some findings they can dismiss in one
 * read, or silence permanently with one line in `.env`.
 */
export function resolveEnvironment(config: ConfigCheckConfig): {
  environment: DeploymentEnv;
  environmentSource: 'explicit' | 'inferred';
  declaredButInvalid: boolean;
} {
  const declared = config.declaredEnv.trim().toLowerCase();
  if (
    declared === 'development' ||
    declared === 'staging' ||
    declared === 'production'
  ) {
    return {
      environment: declared,
      environmentSource: 'explicit',
      declaredButInvalid: false,
    };
  }
  return {
    environment: config.isDevelopment ? 'development' : 'production',
    environmentSource: 'inferred',
    declaredButInvalid: declared !== '',
  };
}

/**
 * The checks that need only configuration — no network, no clock.
 *
 * Split from the async ones so the bulk of the rule set is a pure function of
 * its input: these are the rules most worth testing exhaustively, and the ones
 * where a mistake is most expensive, since a false `ok` here is indistinguish-
 * able from a genuinely well-configured deployment.
 */
export function evaluateStaticChecks(
  config: ConfigCheckConfig,
  env: DeploymentEnv,
  declaredButInvalid: boolean,
): ConfigFinding[] {
  const findings: ConfigFinding[] = [];

  // ---- environment ----
  if (declaredButInvalid) {
    findings.push(
      finding(
        {
          id: 'deployment-env-invalid',
          category: 'environment',
          title: 'DEPLOYMENT_ENV is set to an unrecognized value',
          detail: `Expected development, staging or production. Falling back to ${env}, so every severity below is judged against that.`,
          remediation:
            'Set DEPLOYMENT_ENV in deployment/.env to one of development, staging, production.',
        },
        { development: 'warning', staging: 'warning', production: 'warning' },
        env,
      ),
    );
  }

  // A production-intent deployment running with --dev is a specific, quiet
  // failure: `sessionConfig.secure` is derived from that flag, so the admin
  // session cookie ships without `Secure` and will travel over plain HTTP.
  if (config.isDevelopment && env !== 'development') {
    findings.push(
      finding(
        {
          id: 'dev-flag-in-deployed-env',
          category: 'access',
          title: 'Server is running with --dev outside development',
          detail:
            'The --dev flag clears the Secure attribute on the admin session cookie, so it can be sent over plain HTTP and intercepted.',
          remediation:
            'Start admin-server without --dev, or set DEPLOYMENT_ENV=development if this really is a dev box.',
        },
        { development: 'ok', staging: 'critical', production: 'critical' },
        env,
      ),
    );
  }

  // ---- secrets ----
  const secretChecks: {
    id: string;
    title: string;
    value: string;
    variable: string;
  }[] = [
    {
      id: 'admin-api-key-placeholder',
      title: 'ADMIN_API_KEY is still the example placeholder',
      value: config.adminApiKey,
      variable: 'SESSION_MANAGER_API_KEY',
    },
    {
      id: 'admin-session-secret-placeholder',
      title: 'ADMIN_SESSION_SECRET is still the example placeholder',
      value: config.adminSessionSecret,
      variable: 'ADMIN_SESSION_SECRET',
    },
    {
      id: 'db-password-placeholder',
      title: 'DB_PASSWORD is still the example placeholder',
      value: config.dbPassword,
      variable: 'DB_PASSWORD',
    },
  ];

  for (const check of secretChecks) {
    if (!isPlaceholder(check.value)) continue;
    findings.push(
      finding(
        {
          id: check.id,
          category: 'secrets',
          title: check.title,
          detail: `${describeSecret(check.value)}. Anyone who has read the repository knows this value.`,
          remediation: `Set ${check.variable} in deployment/.env to a high-entropy secret, e.g. \`openssl rand -hex 32\`.`,
        },
        {
          development: 'advisory',
          staging: 'critical',
          production: 'critical',
        },
        env,
      ),
    );
  }

  // ---- session secret strength ----
  // The cookie-signing secret needs 32+ characters. That used to be a boot-time
  // `minLength` on ADMIN_SESSION_SECRET, so a too-short secret crashed the whole
  // console instead of being reported here. The rule now lives with the other
  // checks: reported and graded, not fatal. Guarded on `!isPlaceholder` so a
  // short placeholder is described once, by the placeholder check above, and not
  // a second time by length — one mistake, one finding.
  const MIN_SESSION_SECRET_LENGTH = 32;
  const sessionSecret = config.adminSessionSecret;
  if (!isPlaceholder(sessionSecret)) {
    if (sessionSecret === '') {
      findings.push(
        finding(
          {
            id: 'admin-session-secret-missing',
            category: 'secrets',
            title: 'ADMIN_SESSION_SECRET is not set',
            detail:
              'No session-signing secret is configured, so admin-server signs session cookies with a random secret minted at each start. Every restart silently invalidates all sessions, and separate replicas cannot verify each other’s cookies.',
            remediation:
              'Set ADMIN_SESSION_SECRET in deployment/.env to a high-entropy secret of at least 32 characters, e.g. `openssl rand -hex 32`.',
          },
          {
            development: 'advisory',
            staging: 'warning',
            production: 'critical',
          },
          env,
        ),
      );
    } else if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
      findings.push(
        finding(
          {
            id: 'admin-session-secret-weak',
            category: 'secrets',
            title: 'ADMIN_SESSION_SECRET is shorter than 32 characters',
            detail: `${describeSecret(sessionSecret)}, below the 32-character minimum for the session-cookie signing key, so the cookie signature has less entropy than intended.`,
            remediation:
              'Set ADMIN_SESSION_SECRET in deployment/.env to at least 32 characters, e.g. `openssl rand -hex 32`.',
          },
          {
            development: 'advisory',
            staging: 'warning',
            production: 'critical',
          },
          env,
        ),
      );
    }
  }

  // ---- access ----
  const localLoginEnabled = config.adminLocalCredentials.trim() !== '';
  const ssoConfigured =
    config.azureTenantId !== '' &&
    config.azureClientId !== '' &&
    config.azureClientSecret !== '';

  if (localLoginEnabled && isPlaceholder(config.adminLocalCredentials)) {
    findings.push(
      finding(
        {
          id: 'admin-local-credentials-placeholder',
          category: 'access',
          title: 'The local admin password is still the example placeholder',
          detail:
            'ADMIN_LOCAL_CREDENTIALS still contains the placeholder from deployment/.env.example, so the admin console accepts a publicly known password.',
          remediation:
            'Set ADMIN_LOCAL_CREDENTIALS in deployment/.env to "<username> <strong password>".',
        },
        {
          development: 'advisory',
          staging: 'critical',
          production: 'critical',
        },
        env,
      ),
    );
  }

  if (!localLoginEnabled && !ssoConfigured) {
    // Not a hardening nit: nobody can sign in at all.
    findings.push(
      finding(
        {
          id: 'no-login-method',
          category: 'access',
          title: 'No admin login method is configured',
          detail:
            'ADMIN_LOCAL_CREDENTIALS is empty and Azure SSO is not configured, so no one can sign in to this console.',
          remediation:
            'Set ADMIN_LOCAL_CREDENTIALS, or configure AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET.',
        },
        {
          development: 'critical',
          staging: 'critical',
          production: 'critical',
        },
        env,
      ),
    );
  }

  if (localLoginEnabled && !ssoConfigured) {
    findings.push(
      finding(
        {
          id: 'local-login-only',
          category: 'access',
          title: 'A shared local account is the only way in',
          detail:
            'Azure SSO is not configured, so access cannot be tied to individual staff identities and cannot be revoked centrally.',
          remediation:
            'Configure AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_REDIRECT_URI.',
        },
        { development: 'ok', staging: 'advisory', production: 'warning' },
        env,
      ),
    );
  }

  if (ssoConfigured && config.allowedGroup === '') {
    findings.push(
      finding(
        {
          id: 'sso-no-group-restriction',
          category: 'access',
          title: 'SSO is configured without a group restriction',
          detail:
            'ADMIN_ALLOWED_GROUP is empty, so every account in the tenant that completes SSO can administer this deployment.',
          remediation:
            'Set ADMIN_ALLOWED_GROUP to the group that should hold admin access.',
        },
        { development: 'advisory', staging: 'warning', production: 'critical' },
        env,
      ),
    );
  }

  // ---- telemetry configuration ----
  if (config.redisUrl === '') {
    findings.push(
      finding(
        {
          id: 'fleet-telemetry-disabled',
          category: 'telemetry',
          title: 'Fleet telemetry is switched off for this console',
          detail:
            "ADMIN_REDIS_URL is unset, so the fleet dashboard answers 503 TELEMETRY_UNAVAILABLE. The top-bar health rollup's redis component reports not-configured in the same case — not a failure, but visible there too.",
          remediation:
            'Set ADMIN_REDIS_URL in deployment/.env — see deployment/UPGRADING.md.',
          docUrl: DOC.redis,
        },
        { development: 'advisory', staging: 'advisory', production: 'warning' },
        env,
      ),
    );
  } else if (!redisUrlHasPassword(config.redisUrl)) {
    findings.push(
      finding(
        {
          id: 'redis-url-no-password',
          category: 'telemetry',
          title: 'The telemetry Redis URL carries no password',
          detail:
            'ADMIN_REDIS_URL has no password component, so either Redis is unauthenticated or this console cannot authenticate to it.',
          remediation:
            'Use redis://:<REDIS_PASSWORD>@redis:6379, matching REDIS_PASSWORD in deployment/.env.',
          docUrl: DOC.redis,
        },
        { development: 'advisory', staging: 'warning', production: 'critical' },
        env,
      ),
    );
  }

  return findings;
}

/** True when the URL has a non-empty password component. */
function redisUrlHasPassword(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).password !== '';
  } catch {
    // Unparseable. Reported separately by the reachability check, which will
    // fail to connect; claiming "no password" here would be a second, worse
    // explanation of the same fact.
    return true;
  }
}

/**
 * Builds the admin console's Config Check report.
 *
 * **Scope, and why it stops where it does.** admin-server can read its own
 * environment and nothing else's — there is no endpoint anywhere that discloses
 * another service's configuration, and adding one would be a far larger
 * liability than this page is worth. So the checks are of two kinds: direct
 * ones over admin-server's own variables, and *inferences* from observable
 * behaviour for everything else. The inferences are deliberately phrased as
 * what was observed ("nothing is publishing") rather than as a conclusion about
 * a variable this process cannot see, because the observation is what is true.
 */
export class ConfigCheckService {
  private _config: ConfigCheckConfig;
  private _fleetTelemetryService: AppDependencies['fleetTelemetryService'];
  private _healthCheckerService: AppDependencies['healthCheckerService'];
  private _dbClient: AppDependencies['dbClient'];

  constructor(
    configCheckConfig: ConfigCheckConfig,
    fleetTelemetryService: AppDependencies['fleetTelemetryService'],
    healthCheckerService: AppDependencies['healthCheckerService'],
    dbClient: AppDependencies['dbClient'],
  ) {
    this._config = configCheckConfig;
    this._fleetTelemetryService = fleetTelemetryService;
    this._healthCheckerService = healthCheckerService;
    this._dbClient = dbClient;
  }

  async check(): Promise<ConfigCheckReport> {
    const { environment, environmentSource, declaredButInvalid } =
      resolveEnvironment(this._config);

    const [telemetry, services, database] = await Promise.all([
      this._checkTelemetryBackplane(environment),
      this._checkServiceReachability(environment),
      this._checkDatabase(environment),
    ]);

    const findings = [
      ...evaluateStaticChecks(this._config, environment, declaredButInvalid),
      ...database,
      ...telemetry,
      ...services,
    ];

    const summary: Record<CheckSeverity, number> = {
      critical: 0,
      warning: 0,
      advisory: 0,
      ok: 0,
    };
    for (const f of findings) summary[f.severity] += 1;

    return {
      environment,
      environmentSource,
      findings,
      summary,
      blockingForProduction: findings.filter(
        (f) => f.productionSeverity === 'critical',
      ).length,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Connects to the backplane and asks who is publishing.
   *
   * The publisher inference is the only way this console can say anything about
   * `NODE_SERVER_REDIS_URL` and `TRANSCRIPTION_REDIS_URL`, which live in other
   * containers. An empty snapshot from a reachable Redis means nothing is
   * publishing — which on a deployment that has any traffic at all means those
   * variables were never set.
   */
  private async _checkTelemetryBackplane(
    env: DeploymentEnv,
  ): Promise<ConfigFinding[]> {
    if (!this._fleetTelemetryService.enabled) return [];

    try {
      const snapshot = await this._fleetTelemetryService.snapshot();
      const publishers =
        snapshot.nodes.length + snapshot.transcriptionHosts.length;
      if (publishers > 0) return [];

      return [
        finding(
          {
            id: 'telemetry-no-publishers',
            category: 'telemetry',
            title: 'The telemetry backplane is reachable but empty',
            detail:
              'Redis answered, and no node-server or transcription-service instance has published a snapshot. Those services publish only when their own REDIS_URL is set, so the dashboard will stay empty until it is.',
            remediation:
              'Set NODE_SERVER_REDIS_URL and TRANSCRIPTION_REDIS_URL in deployment/.env and restart those services — see deployment/UPGRADING.md.',
            docUrl: DOC.redis,
          },
          {
            development: 'advisory',
            staging: 'warning',
            production: 'warning',
          },
          env,
        ),
      ];
    } catch {
      return [
        finding(
          {
            id: 'telemetry-unreachable',
            category: 'telemetry',
            title: 'The telemetry backplane is configured but unreachable',
            detail:
              'ADMIN_REDIS_URL is set and the connection failed. This is a broken deployment rather than a disabled feature: something was configured and does not work.',
            remediation:
              'Check that the redis service is running and that ADMIN_REDIS_URL host, port and password match REDIS_PASSWORD in deployment/.env.',
            docUrl: DOC.redis,
          },
          {
            development: 'warning',
            staging: 'critical',
            production: 'critical',
          },
          env,
        ),
      ];
    }
  }

  /**
   * Turns the health rollup into findings, so the same failing dependency the
   * dashboard shows red also appears here with a fix and a wiki link.
   *
   * The three bad statuses are three different operator problems, and lumping
   * them together (or, as this check used to, reporting only `unreachable`) is
   * why a service that was up but failing its own readiness — the single most
   * common real incident — could leave this page saying "nothing to report"
   * while the dashboard showed it red:
   *
   * - `unreachable`: no answer at all. Usually a container that was never
   *   recreated after a compose change, not a misconfiguration.
   * - `fail`: reachable, and answering that it is unhealthy. It is up and
   *   telling you what is wrong — almost always a dependency of its own, and
   *   `database: fail` most often means the scribear-db migrations never ran.
   * - `degraded`: working but impaired (transcription-service says this when
   *   every worker is saturated). Usually load, usually self-clearing.
   *
   * The failing/unreachable services' own `detail` is carried through verbatim,
   * because "session-manager (database: fail)" is the line that turns a red dot
   * into a next step.
   */
  private async _checkServiceReachability(
    env: DeploymentEnv,
  ): Promise<ConfigFinding[]> {
    const components = await this._healthCheckerService.check();

    /** "name (detail)" for each component, or just "name" when there is none. */
    const list = (cs: typeof components): string =>
      cs
        .map((c) =>
          c.detail === undefined ? c.name : `${c.name} (${c.detail})`,
        )
        .join(', ');

    const findings: ConfigFinding[] = [];

    const unreachable = components.filter((c) => c.status === 'unreachable');
    if (unreachable.length > 0) {
      findings.push(
        finding(
          {
            id: 'services-unreachable',
            category: 'services',
            title: `${String(unreachable.length)} service(s) cannot be reached`,
            detail: `No answer from: ${list(unreachable)}. After an upgrade this usually means the container was never recreated, not that it is misconfigured.`,
            remediation:
              'Run `docker compose up -d` in deployment/ and re-check. If it persists, see the per-service detail in the health rollup.',
            docUrl: DOC.deployment,
          },
          {
            development: 'warning',
            staging: 'critical',
            production: 'critical',
          },
          env,
        ),
      );
    }

    const failing = components.filter((c) => c.status === 'fail');
    if (failing.length > 0) {
      findings.push(
        finding(
          {
            id: 'services-failing',
            category: 'services',
            title: `${String(failing.length)} service(s) report themselves unhealthy`,
            detail: `Reachable but failing their own readiness check: ${list(failing)}. The service is up and telling you what is wrong — usually a dependency of its own (its database, Redis, or a migration that never ran).`,
            remediation:
              'Read the detail above, then that service\'s logs (`docker compose logs <service>`). A "database: fail" almost always means the scribear-db migrations have not been run.',
            docUrl: DOC.migrations,
          },
          {
            development: 'warning',
            staging: 'critical',
            production: 'critical',
          },
          env,
        ),
      );
    }

    const degraded = components.filter((c) => c.status === 'degraded');
    if (degraded.length > 0) {
      findings.push(
        finding(
          {
            id: 'services-degraded',
            category: 'services',
            title: `${String(degraded.length)} service(s) are degraded`,
            detail: `Working but impaired: ${list(degraded)}. transcription-service reports this when every worker is saturated.`,
            remediation:
              'Usually load-related and self-clearing. If it persists, check the named service’s capacity and logs.',
          },
          {
            development: 'advisory',
            staging: 'advisory',
            production: 'warning',
          },
          env,
        ),
      );
    }

    return findings;
  }

  /**
   * The Postgres dependency: is it configured, reachable, and migrated?
   *
   * These are the three ways the audit log and admin sessions fail from the
   * database side, and the operator's next step differs for each — a missing
   * variable, a container that is not up, and migrations that never ran are
   * three separate wiki steps. Checked in order and short-circuited: an
   * unconfigured database is not meaningfully "unreachable", and an unreachable
   * one cannot be asked about its schema. Every finding carries a `docUrl` so
   * the fix is one click away rather than a search through the deployment guide.
   */
  private async _checkDatabase(env: DeploymentEnv): Promise<ConfigFinding[]> {
    const { dbHost, dbName, dbUser } = this._config;

    if (dbHost === '' || dbName === '' || dbUser === '') {
      return [
        finding(
          {
            id: 'database-not-configured',
            category: 'services',
            title: 'The database connection is not fully configured',
            detail:
              'One of DB_HOST, DB_NAME or DB_USER is empty, so admin-server has no Postgres to store the audit log in or authenticate against.',
            remediation:
              'Set DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD in deployment/.env.',
            docUrl: DOC.postgres,
          },
          {
            development: 'critical',
            staging: 'critical',
            production: 'critical',
          },
          env,
        ),
      ];
    }

    try {
      await this._dbClient.ping();
    } catch (err) {
      return [
        finding(
          {
            id: 'database-unreachable',
            category: 'services',
            title: 'The database is configured but unreachable',
            detail: `admin-server could not connect to Postgres (DB_HOST=${dbHost}): ${
              err instanceof Error ? err.message : 'connection failed'
            }. The audit log and admin session store both depend on it.`,
            remediation:
              'Check that the scribear-db service is running and that DB_HOST, DB_PORT, DB_USER and DB_PASSWORD in deployment/.env match it.',
            docUrl: DOC.postgres,
          },
          {
            development: 'warning',
            staging: 'critical',
            production: 'critical',
          },
          env,
        ),
      ];
    }

    if (!(await this._databaseHasSchema())) {
      return [
        finding(
          {
            id: 'database-schema-missing',
            category: 'services',
            title: 'The database is reachable but the admin schema is missing',
            detail:
              'The admin_audit_log table does not exist. admin-server applies its own migrations on startup, so this usually means that startup migration failed rather than a configuration mistake.',
            remediation:
              'Restart admin-server and check its logs for a migration error, then run the database migration step from the deployment guide.',
            docUrl: DOC.migrations,
          },
          {
            development: 'warning',
            staging: 'critical',
            production: 'critical',
          },
          env,
        ),
      ];
    }

    return [];
  }

  /**
   * True when admin-server's own table exists. `to_regclass` resolves the name
   * to null instead of raising when it is absent, so a missing schema is a
   * clean `false` rather than an exception that would read as unreachable.
   */
  private async _databaseHasSchema(): Promise<boolean> {
    try {
      return await this._dbClient.hasAdminSchema();
    } catch {
      return false;
    }
  }
}
