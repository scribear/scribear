import { isIPv4, isIPv6 } from 'node:net';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import {
  LATEST_MIGRATION,
  MIGRATION_TABLE,
  type SchemaState,
} from '@scribear/scribear-db';

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
  | 'environment'
  | 'monitoring'
  | 'backups';

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
  monitoring: `${WIKI}/Deployment#monitoring`,
} as const;

/**
 * The shape of `GET /api/monitoring/v1/config-audit` on the monitoring
 * sidecar (PLAN-ConfigCheck-Coverage Phase 2). Restated here rather than
 * imported — the sidecar has no schema package other services depend on
 * (unlike node-server/session-manager/transcription-service), the same
 * reasoning `_prometheusIsScrapingSidecar`'s local `TargetsResponse`
 * interface already follows for Prometheus's API.
 *
 * A runtime schema rather than a bare `interface` + cast, because this body
 * crosses a version boundary: an older or newer sidecar can answer 200 with a
 * shape this build does not know, and every field below is dereferenced
 * unconditionally afterwards. `Value.Check` is what
 * `NodeStatusPollerService._parseBody` already does one hop upstream for the
 * same reason.
 */
const CONFIG_AUDIT_RESPONSE_SCHEMA = Type.Object({
  nodeServer: Type.Union([
    Type.Object({
      status: Type.Literal('ok'),
      secretPlaceholders: Type.Object({
        sessionTokenSigningKeyIsPlaceholder: Type.Boolean(),
        sessionManagerServiceApiKeyIsPlaceholder: Type.Boolean(),
        nodeServerServiceApiKeyIsPlaceholder: Type.Boolean(),
        transcriptionServiceApiKeyIsPlaceholder: Type.Boolean(),
      }),
    }),
    Type.Object({
      status: Type.Literal('unavailable'),
      reason: Type.String(),
    }),
  ]),
});

type ConfigAuditResponse = Static<typeof CONFIG_AUDIT_RESPONSE_SCHEMA>;

/**
 * The one value of `nodeServer.reason` that reports a *disagreement* rather
 * than an outage: `AbsoluteStatusPoller`'s `POLL_ERROR_REASONS.UNAUTHORIZED`,
 * which the sidecar sets when node-server answered its status poll 401 or 403.
 *
 * Restated here as a bare string for the same reason the response schema above
 * is restated: the sidecar exports no package for admin-server to import, and
 * `reason` crosses a version boundary as an open `Type.String()`. An older or
 * newer sidecar that renamed the reason therefore degrades to the generic
 * "could not check" finding rather than to a wrong claim — which is the safe
 * direction for a string this file cannot typecheck against its producer.
 */
const SIDECAR_POLL_UNAUTHORIZED = 'unauthorized';

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
  /** admin-server's inbound key for the test-audio generator (`TestAudioConfig.serviceKey`). */
  testAudioServiceKey: string;
  /**
   * Base URL of Grafana, reached only over the backend network. Empty unless
   * the `monitoring` compose profile is on — see `_checkMonitoring`.
   */
  grafanaBaseUrl: string;
  /** Base URL of Prometheus, reached only over the backend network. Empty unless the `monitoring` compose profile is on. */
  prometheusBaseUrl: string;
  /**
   * Base URL of the monitoring sidecar, reached only over the backend
   * network. Unlike `grafanaBaseUrl`/`prometheusBaseUrl` this is never empty
   * in practice — the sidecar is a core service with no compose profile —
   * used to read `/api/monitoring/v1/config-audit` (PLAN-ConfigCheck-Coverage
   * Phase 2): node-server's self-reported classification of whether
   * JWT_SECRET/NODE_SERVER_KEY/NODE_SERVER_SERVICE_KEY/TRANSCRIPTION_API_KEY
   * are still placeholders, relayed through the sidecar because it already
   * holds the key node-server's status endpoint requires and admin-server
   * never needs to.
   */
  monitoringSidecarBaseUrl: string;
  /** db-backup's own `BACKUP_OFFSITE_METHOD` — "none", "scp" or "rsync". */
  backupOffsiteMethod: string;
  /** db-backup's own `BACKUP_INTERVAL_SECONDS` — how stale is too stale. */
  backupIntervalSeconds: number;
  /** db-backup's own `BACKUP_ENABLED` — false means deliberately idling. */
  backupEnabled: boolean;
  azureTenantId: string;
  azureClientId: string;
  azureClientSecret: string;
  /** Never previously read here — see `sso-incomplete-config`'s history. */
  azureRedirectUri: string;
  allowedGroup: string;
  /**
   * Bound on asking session-manager what schema version it expects. Shared with
   * the health rollup's timeout, since both are questions an operator is waiting
   * on and a hung sibling service must not hold this page open.
   */
  upstreamTimeoutMs: number;
}

/** See `evaluateStaticChecks`'s "local admin password strength" section. */
const MIN_LOCAL_PASSWORD_LENGTH = 8;

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
 * Splits `ADMIN_LOCAL_CREDENTIALS` into its password half, mirroring
 * `LocalAuthService`'s own parse rule exactly — split on the FIRST space
 * only, so the password may itself contain spaces — so this check and
 * boot-time parsing can never disagree about what the password actually is.
 * Deliberately duplicated rather than imported: `LocalAuthService`'s parse is
 * private to its constructor, and re-deriving three characters of `indexOf`
 * logic here is cheaper and lower-risk than exporting it and coupling the two
 * files together for a one-line rule.
 *
 * Returns `null` for anything `LocalAuthService` itself treats as malformed —
 * no space, an empty username, or an empty password — which is reported as
 * its own finding rather than measured as a (nonexistent) password.
 */
function parseLocalCredentialsPassword(raw: string): string | null {
  const spaceIdx = raw.indexOf(' ');
  if (spaceIdx <= 0 || spaceIdx === raw.length - 1) return null;
  return raw.slice(spaceIdx + 1);
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
    {
      id: 'test-audio-service-key-placeholder',
      title: 'TEST_AUDIO_SERVICE_KEY is still the example placeholder',
      value: config.testAudioServiceKey,
      variable: 'TEST_AUDIO_SERVICE_KEY',
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

  // ---- secrets that are not set at all ----
  // `isPlaceholder('')` is false and the loop above skips everything that is
  // not a placeholder, so an *unset* secret used to produce no finding
  // whatsoever — the quieter half of the same mistake, and the likelier one:
  // compose substitutes a blank string for a variable an operator never set,
  // renamed, or deleted, and nothing complains until the first request fails
  // somewhere else. Kept as its own table rather than folded into the one
  // above because "not set" and "still the example value" have different
  // consequences and want different sentences; `describeSecret`'s 'not set'
  // branch is finally reachable from here.
  //
  // Two deliberate absences. `ADMIN_SESSION_SECRET` has its own
  // `admin-session-secret-missing` below, which says something more specific
  // (admin-server mints an ephemeral secret rather than failing).
  // `TEST_AUDIO_SERVICE_KEY` is left out because a static check is the weakest
  // available evidence about it: it is the one key on this list whose peer
  // fails closed and says so itself — test-audio-generator exits naming the
  // variable — and whose agreement admin-server can establish by simply
  // calling the generator, which is a separate check to make rather than a
  // string comparison to add here.
  const missingSecretChecks: {
    id: string;
    title: string;
    value: string;
    variable: string;
    consequence: string;
    severities: SeverityByEnv;
  }[] = [
    {
      id: 'admin-api-key-missing',
      title: 'ADMIN_API_KEY is not set',
      value: config.adminApiKey,
      variable: 'SESSION_MANAGER_API_KEY',
      consequence:
        'admin-server presents `Authorization: Bearer ` with nothing after it on every call to session-manager, which rejects it 401. This console answers 502 BACKEND_MISCONFIGURATION on every page that lists rooms, devices or sessions.',
      severities: {
        development: 'critical',
        staging: 'critical',
        production: 'critical',
      },
    },
    {
      id: 'db-password-missing',
      title: 'DB_PASSWORD is not set',
      value: config.dbPassword,
      variable: 'DB_PASSWORD',
      consequence:
        'admin-server connects to Postgres with no password. That works only where the database is configured to trust the connection without one, which no deployed Postgres should be; otherwise the audit log and the admin session store are both unavailable.',
      // Warning rather than critical in development because a throwaway dev
      // Postgres on `trust` authentication genuinely works this way, and a
      // developer who chose that has not misconfigured anything.
      severities: {
        development: 'warning',
        staging: 'critical',
        production: 'critical',
      },
    },
  ];

  for (const check of missingSecretChecks) {
    if (check.value !== '') continue;
    findings.push(
      finding(
        {
          id: check.id,
          category: 'secrets',
          title: check.title,
          detail: `${describeSecret(check.value)}. ${check.consequence}`,
          remediation: `Set ${check.variable} in deployment/.env to a high-entropy secret, e.g. \`openssl rand -hex 32\`, and recreate the containers that read it.`,
        },
        check.severities,
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
  // Loose "has an operator started down the SSO path" signal (3 of 5 vars) —
  // deliberately looser than `isEnabled()`, since `local-login-only`'s job is
  // "nudge someone who hasn't started" rather than "is SSO actually live."
  const ssoConfigured =
    config.azureTenantId !== '' &&
    config.azureClientId !== '' &&
    config.azureClientSecret !== '';

  // Mirrors AzureOidcAuthService.isEnabled() exactly (all five vars) — this
  // is the one that must answer "can someone actually complete SSO login,"
  // not just "has an operator started configuring it." `no-login-method`
  // below used to check the looser `ssoConfigured` and could report a
  // deployment as having a working login method while local login was off
  // and SSO was three-of-five-vars configured — i.e. actually unusable,
  // silently. Fixed here rather than left as a footnote: this is exactly the
  // "guard inherits the defect it's guarding" shape this deployment's own
  // conventions call out elsewhere.
  const azureVars = {
    AZURE_TENANT_ID: config.azureTenantId,
    AZURE_CLIENT_ID: config.azureClientId,
    AZURE_CLIENT_SECRET: config.azureClientSecret,
    AZURE_REDIRECT_URI: config.azureRedirectUri,
    ADMIN_ALLOWED_GROUP: config.allowedGroup,
  };
  const azureVarsSet = Object.values(azureVars).filter((v) => v !== '').length;
  const ssoFullyConfigured = azureVarsSet === 5;

  const missingAzureVars = Object.entries(azureVars)
    .filter(([, value]) => value === '')
    .map(([key]) => key);
  // Excludes the case where ADMIN_ALLOWED_GROUP is the ONLY thing missing:
  // `sso-no-group-restriction` below already reports that specific,
  // actionable case (and at a higher severity) — firing both here would be
  // two findings naming the same root cause.
  const missingBeyondGroup = missingAzureVars.filter(
    (key) => key !== 'ADMIN_ALLOWED_GROUP',
  );

  if (azureVarsSet > 0 && azureVarsSet < 5 && missingBeyondGroup.length > 0) {
    const missing = missingAzureVars;
    findings.push(
      finding(
        {
          id: 'sso-incomplete-config',
          category: 'access',
          title: 'Azure SSO configuration is incomplete',
          detail:
            `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} ` +
            'empty while other AZURE_*/ADMIN_ALLOWED_GROUP variables are ' +
            'set. AzureOidcAuthService.isEnabled() requires all five, so SSO ' +
            'stays disabled — the only visible symptom is the "Sign in with ' +
            'Illinois" button not appearing, with nothing pointing at why.',
          remediation: `Set ${missing.join(', ')}, or clear the other Azure variables if SSO isn't intended yet.`,
        },
        { development: 'advisory', staging: 'warning', production: 'warning' },
        env,
      ),
    );
  }

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

  // ---- local admin password strength ----
  // Guarded on `!isPlaceholder` for the same reason the session-secret length
  // check is: a placeholder value is already reported once, above, and
  // reporting it a second time here (as "too short") would be a second
  // finding for one cause. `ADMIN_LOCAL_CREDENTIALS` is not itself the
  // secret — it is `"<username> <password>"`, parsed by `LocalAuthService`
  // (split on the FIRST space only, so the password may contain spaces) — so
  // measuring `config.adminLocalCredentials.length` directly would be
  // measuring the username too, and would never fall to zero even for a
  // one-character password. `parseLocalCredentialsPassword` mirrors that
  // parse rule exactly so this check and boot-time parsing can never
  // disagree about what the password actually is.
  if (localLoginEnabled && !isPlaceholder(config.adminLocalCredentials)) {
    const parsedPassword = parseLocalCredentialsPassword(
      config.adminLocalCredentials,
    );

    if (parsedPassword === null) {
      // No space, an empty username, or an empty password:
      // `LocalAuthService` treats this as malformed and disables local login
      // entirely (with a warn-level log), which `localLoginEnabled` above
      // does not know — it is only `.trim() !== ''`. Worth its own finding
      // rather than folding into `no-login-method` below: that check already
      // has its own SSO-completeness reasoning, and conflating "local login
      // is configured but broken" with "local login was never configured"
      // would point the operator at the wrong fix (configure SSO) instead of
      // the actual one (fix the format).
      findings.push(
        finding(
          {
            id: 'admin-local-credentials-malformed',
            category: 'access',
            title: 'ADMIN_LOCAL_CREDENTIALS is set but malformed',
            detail:
              'The value has no space separating a username from a password (or an empty username/password), so LocalAuthService disables local login entirely at boot. The admin console silently falls back to SSO only, with nothing on the sign-in page saying why.',
            remediation:
              'Set ADMIN_LOCAL_CREDENTIALS in deployment/.env to "<username> <password>" (one space between the two), or clear it entirely to disable local login on purpose.',
          },
          {
            development: 'advisory',
            staging: 'critical',
            production: 'critical',
          },
          env,
        ),
      );
    } else if (parsedPassword.length < MIN_LOCAL_PASSWORD_LENGTH) {
      // The bar here is deliberately not the 32-character random-secret
      // minimum `ADMIN_SESSION_SECRET` gets above: that value is generated
      // once and never typed by a human, so asking for high entropy costs
      // nothing. This one is a memorized password behind a login form, where
      // NIST SP 800-63B's guidance is a length floor rather than a forced
      // high-entropy string — 8 characters, the same floor OWASP ASVS L1
      // uses. Below that, a password is guessable in a practical number of
      // attempts even behind the login route's own rate limit.
      findings.push(
        finding(
          {
            id: 'admin-local-credentials-weak',
            category: 'access',
            title: `The local admin password is shorter than ${String(MIN_LOCAL_PASSWORD_LENGTH)} characters`,
            detail: `${describeSecret(parsedPassword)}, below the ${String(MIN_LOCAL_PASSWORD_LENGTH)}-character minimum (NIST SP 800-63B / OWASP ASVS L1) for a password protecting full read-write admin access.`,
            remediation: `Set ADMIN_LOCAL_CREDENTIALS in deployment/.env to "<username> <password>" with a password of at least ${String(MIN_LOCAL_PASSWORD_LENGTH)} characters — a short passphrase of a few random words is both easy to remember and long enough.`,
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

  if (!localLoginEnabled && !ssoFullyConfigured) {
    // Not a hardening nit: nobody can sign in at all. Checks the same
    // 5-var completeness as `isEnabled()`, not the looser `ssoConfigured` —
    // a deployment with 3-of-5 Azure vars set does NOT have a working SSO
    // login, so it must not read as "fine" here just because it looks
    // SSO-configured to the looser check above.
    findings.push(
      finding(
        {
          id: 'no-login-method',
          category: 'access',
          title: 'No admin login method is configured',
          detail:
            'ADMIN_LOCAL_CREDENTIALS is empty and Azure SSO is not fully configured (or not configured at all), so no one can sign in to this console.',
          remediation:
            'Set ADMIN_LOCAL_CREDENTIALS, or configure all five: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_REDIRECT_URI and ADMIN_ALLOWED_GROUP.',
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
  } else if (redisUrlHasPlaceholderPassword(config.redisUrl)) {
    findings.push(
      finding(
        {
          id: 'redis-url-placeholder-password',
          category: 'telemetry',
          title:
            'The telemetry Redis URL is still the example placeholder password',
          detail:
            "ADMIN_REDIS_URL's password is still the deployment/.env.example placeholder. Anyone who has read the repository knows this value.",
          remediation:
            'Set REDIS_PASSWORD in deployment/.env to a high-entropy secret, then update ADMIN_REDIS_URL (and NODE_SERVER_REDIS_URL/TRANSCRIPTION_REDIS_URL, if set) to match.',
          docUrl: DOC.redis,
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

  return findings;
}

/**
 * True when `host` (a Host-header hostname — no port, no brackets) certainly
 * cannot be resolved by a device outside this host/network: loopback,
 * RFC1918/link-local IPv4, loopback/unique-local/link-local IPv6, `.local`
 * mDNS, or a bare single-label name — the shape of a Docker Compose service
 * name or a LAN machine's own hostname, which resolves only on that specific
 * network's DNS.
 *
 * Deliberately one-directional. A host that passes this (has a dot, isn't a
 * private/loopback IP) is merely *not ruled out* — admin-server sits inside
 * the backend network and has no way to dial out and confirm anything
 * resolves from a device that isn't itself, so a normal-looking public FQDN
 * is reported as "nothing to say", never as "reachable". Overstating that
 * confidence is exactly the failure mode this check exists to avoid; see
 * `evaluatePublicOriginCheck`'s doc.
 */
function looksUnreachableExternally(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;

  if (isIPv4(h)) {
    const octets = h.split('.').map(Number);
    const [a, b] = octets;
    if (a === undefined || b === undefined) return false;
    return (
      a === 127 || // loopback
      a === 10 || // RFC1918
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 169 && b === 254) || // link-local
      a === 0 // "this network"
    );
  }

  if (isIPv6(h)) {
    return (
      h === '::1' || // loopback
      h.startsWith('fc') || // unique-local fc00::/7
      h.startsWith('fd') ||
      h.startsWith('fe8') || // link-local fe80::/10
      h.startsWith('fe9') ||
      h.startsWith('fea') ||
      h.startsWith('feb')
    );
  }

  // No dot at all: not a real FQDN, so it can only be a bare label — a
  // Compose service name (`admin-server`), an unqualified LAN hostname, or
  // similar. None of those resolve outside the network that hands them out.
  return !h.includes('.');
}

/**
 * Is the address this request reached admin-server on one that certainly
 * will not resolve for the audience a QR code is meant for?
 *
 * There is no `PUBLIC_ORIGIN` (or equivalent) variable anywhere in this
 * deployment for admin-server to read and check — confirmed by reading
 * `deployment/compose.yml` and `infra/scribear-nginx/nginx.conf`: nginx's own
 * `server_name` is the wildcard `_` (matches any Host), and the one `ORIGIN`
 * value in `deployment/.env.example` is read only by the demo curl scripts
 * (`deployment/create-room.sh` and siblings), never by nginx or any service.
 * `apps/admin-webapp/src/lib/join-url.ts` and `kiosk-url.ts` build every join
 * link and kiosk QR code from `window.location.origin` — literally whatever
 * host the operator's own browser used to reach the admin console — so the
 * *only* place this fact exists is the Host header of the request that
 * asked for this very report, forwarded unchanged by nginx
 * (`proxy_set_header Host $host;`).
 *
 * That makes this check necessarily request-scoped, not deployment-scoped: it
 * says "the address you reached this page on", not "the deployment's public
 * origin" — a different admin, or the same admin through a different tunnel,
 * could get a different answer from the same deployment. And it can only
 * rule addresses *out*: admin-server sits inside the backend network with no
 * way to dial out from a device that isn't itself, so a normal-looking public
 * hostname is reported as nothing (silence, like every other check on this
 * page that found no problem) rather than as verified-reachable — see
 * `looksUnreachableExternally`'s doc for why overclaiming here would be worse
 * than staying silent.
 */
export function evaluatePublicOriginCheck(
  requestHostname: string,
  env: DeploymentEnv,
): ConfigFinding[] {
  const host = requestHostname.trim();
  // Should not happen over HTTP/1.1+ (Host is mandatory), and there is
  // nothing to check without one — not worth its own finding.
  if (host === '') return [];

  if (!looksUnreachableExternally(host)) return [];

  return [
    finding(
      {
        id: 'public-origin-not-externally-resolvable',
        category: 'access',
        title:
          'The address used to reach this console will not resolve outside this host/network',
        detail: `This request reached admin-server as "${host}" — a loopback, private-network, or container-local address. join-url.ts and kiosk-url.ts build every join link and kiosk QR code from exactly this address (the browser's own window.location.origin), so a QR code generated by an operator reaching the console this way will not resolve for anyone outside this host or network — invisible until a room fails in front of an audience. admin-server cannot confirm the opposite (that a normal-looking public hostname actually resolves off-host) from inside the backend network, so this check only catches addresses that certainly will not work.`,
        remediation:
          'Reach the admin console through the same public DNS name your audience will use to scan the QR code (e.g. https://scribear.example.edu), not a loopback address, private IP, VPN-only alias, or bare container/service name. If a load balancer or reverse proxy sits in front of this nginx, verify it forwards the public Host header rather than an internal one.',
      },
      { development: 'advisory', staging: 'critical', production: 'critical' },
      env,
    ),
  ];
}

/**
 * Why a `_probe` call did not produce a usable answer, as a clause to drop
 * into a finding's detail.
 *
 * Worth spelling out rather than assuming a timeout: `_probe` returns `null`
 * for both an abort at `upstreamTimeoutMs` and an immediate connection/DNS
 * failure — indistinguishable from its `catch`, hence the deliberately
 * unspecific "did not answer" — but a non-`null` response that failed
 * `.ok` is a service that answered promptly with an error status, which
 * "did not answer within Nms" would describe simply wrongly, sending an
 * operator looking for a network problem that isn't there.
 */
function probeFailure(response: Response | null, timeoutMs: number): string {
  return response === null
    ? `did not answer within ${String(timeoutMs)}ms`
    : `answered HTTP ${String(response.status)}`;
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
 * True when the URL's password is still the `deployment/.env.example`
 * placeholder — e.g. a copied `redis://:CHANGEME@redis:6379` where
 * `REDIS_PASSWORD` was since changed but `ADMIN_REDIS_URL` was not.
 */
function redisUrlHasPlaceholderPassword(rawUrl: string): boolean {
  try {
    return isPlaceholder(new URL(rawUrl).password);
  } catch {
    // Unparseable. Reported separately by the reachability check.
    return false;
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
 *
 * **How agreement between two services is established, and where it stops.**
 * Nothing in this deployment exchanges digests of secrets, and nothing should
 * start: the sidecar's `/config-audit` is unauthenticated on the backend
 * network, so a fingerprint published there would be a slower way of
 * disclosing a low-entropy secret to anything that can reach it. The only
 * mechanism available is the one the sidecar's status poll already uses — a
 * party holding one copy of a key presents it to the party holding the other,
 * and the rejection is the proof. That covers exactly the pairs where a
 * mutually-trusted party holds one side: sidecar↔node-server
 * (`_nodeServerServiceKeyMismatch`) and admin-server↔session-manager
 * (`_checkSessionManagerKey`).
 *
 * It does **not** cover `TRANSCRIPTION_API_KEY`, `NODE_SERVER_KEY` or
 * `JWT_SECRET`. Each of those is held only by the two services that use it,
 * neither of which exercises it until a real session starts, and none of them
 * reports the outcome when it does — a rejected `TRANSCRIPTION_API_KEY` closes
 * the upstream socket 1008 "Authentication Failed" and node-server records
 * only a generic upstream flap. Closing that gap needs a new self-report from
 * node-server, not a new check here, and it is deliberately not faked with an
 * inference this page cannot stand behind.
 */
export class ConfigCheckService {
  private _config: ConfigCheckConfig;
  private _fleetTelemetryService: AppDependencies['fleetTelemetryService'];
  private _healthCheckerService: AppDependencies['healthCheckerService'];
  private _dbClient: AppDependencies['dbClient'];
  private _sessionManagerGatewayService: AppDependencies['sessionManagerGatewayService'];
  private _backupDirectoryService: AppDependencies['backupDirectoryService'];
  private _testAudioGatewayService: AppDependencies['testAudioGatewayService'];

  constructor(
    configCheckConfig: ConfigCheckConfig,
    fleetTelemetryService: AppDependencies['fleetTelemetryService'],
    healthCheckerService: AppDependencies['healthCheckerService'],
    dbClient: AppDependencies['dbClient'],
    sessionManagerGatewayService: AppDependencies['sessionManagerGatewayService'],
    backupDirectoryService: AppDependencies['backupDirectoryService'],
    testAudioGatewayService: AppDependencies['testAudioGatewayService'],
  ) {
    this._config = configCheckConfig;
    this._fleetTelemetryService = fleetTelemetryService;
    this._healthCheckerService = healthCheckerService;
    this._dbClient = dbClient;
    this._sessionManagerGatewayService = sessionManagerGatewayService;
    this._backupDirectoryService = backupDirectoryService;
    this._testAudioGatewayService = testAudioGatewayService;
  }

  /**
   * @param requestHostname The Host header of the request that asked for
   * this report (no port), used only by `evaluatePublicOriginCheck` — see
   * its doc for why this one check is necessarily request-scoped rather than
   * a property of `ConfigCheckConfig`. Defaults to `''` (no finding) so every
   * existing direct caller of `.check()` — the great majority of this file's
   * own unit tests — is unaffected; only the HTTP route passes a real value.
   */
  async check(requestHostname = ''): Promise<ConfigCheckReport> {
    const { environment, environmentSource, declaredButInvalid } =
      resolveEnvironment(this._config);

    const [
      telemetry,
      services,
      database,
      monitoring,
      secretPlaceholders,
      sessionManagerKey,
      backup,
      testAudioServiceKey,
    ] = await Promise.all([
      this._checkTelemetryBackplane(environment),
      this._checkServiceReachability(environment),
      this._checkDatabase(environment),
      this._checkMonitoring(environment),
      this._checkSecretPlaceholders(environment),
      this._checkSessionManagerKey(environment),
      this._checkBackup(environment),
      this._checkTestAudioServiceKey(environment),
    ]);

    const findings = [
      ...evaluateStaticChecks(this._config, environment, declaredButInvalid),
      ...evaluatePublicOriginCheck(requestHostname, environment),
      ...database,
      ...telemetry,
      ...services,
      ...monitoring,
      ...secretPlaceholders,
      ...sessionManagerKey,
      ...backup,
      ...testAudioServiceKey,
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
   * Is the `monitoring` compose profile (if the operator turned it on)
   * actually working — Prometheus reachable and scraping its one target,
   * Grafana reachable and its default password actually changed.
   *
   * Unlike most optional features on this page, an unset pair of base URLs is
   * not treated as silent: a fleet-health dashboard is worth having in
   * staging and production, so leaving it off is worth a nudge there (not in
   * development, where a dashboard for a single throwaway container buys
   * nothing). Reachability is gated on both `grafanaBaseUrl` and
   * `prometheusBaseUrl` being set, since a deployment that never turns the
   * profile on has neither container running, and probing them would report
   * a false `unreachable` rather than the true fact.
   *
   * Each of Prometheus and Grafana is checked independently once configured:
   * an operator who only wired one of the two base URLs (unusual, but not
   * invalid) still gets a report on whichever one they configured.
   */
  private async _checkMonitoring(env: DeploymentEnv): Promise<ConfigFinding[]> {
    const { grafanaBaseUrl, prometheusBaseUrl } = this._config;

    if (grafanaBaseUrl === '' && prometheusBaseUrl === '') {
      return [
        finding(
          {
            id: 'monitoring-not-configured',
            category: 'monitoring',
            title: 'The fleet-health dashboard is not set up',
            detail:
              'ADMIN_GRAFANA_BASE_URL and ADMIN_PROMETHEUS_BASE_URL are both unset, so Config Check cannot see whether the monitoring compose profile is on, and there is no dashboard for evaluators or on-call staff to check.',
            remediation:
              'Add monitoring to COMPOSE_PROFILES in deployment/.env, then set ADMIN_GRAFANA_BASE_URL and ADMIN_PROMETHEUS_BASE_URL — see deployment/monitoring/README.md.',
            docUrl: DOC.monitoring,
          },
          {
            development: 'advisory',
            staging: 'warning',
            production: 'warning',
          },
          env,
        ),
      ];
    }

    const [prometheus, grafana] = await Promise.all([
      prometheusBaseUrl === ''
        ? Promise.resolve([])
        : this._checkPrometheus(prometheusBaseUrl, env),
      grafanaBaseUrl === ''
        ? Promise.resolve([])
        : this._checkGrafana(grafanaBaseUrl, env),
    ]);

    return [...prometheus, ...grafana];
  }

  /** `fetch` with the shared upstream timeout, `null` on any failure to answer at all. */
  private async _probe(
    url: string,
    init?: RequestInit,
  ): Promise<Response | null> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this._config.upstreamTimeoutMs),
      });
    } catch {
      return null;
    }
  }

  /**
   * Reachable, and scraping the one target it is configured to scrape
   * (`deployment/monitoring/prometheus.yml`'s `scribear_sidecar` job).
   * Short-circuited like `_checkDatabase`: an unreachable Prometheus cannot
   * meaningfully be asked what it is scraping.
   */
  private async _checkPrometheus(
    baseUrl: string,
    env: DeploymentEnv,
  ): Promise<ConfigFinding[]> {
    const health = await this._probe(`${baseUrl}/-/healthy`);
    if (!health?.ok) {
      return [
        finding(
          {
            id: 'monitoring-prometheus-unreachable',
            category: 'monitoring',
            title: 'Prometheus is configured but unreachable',
            detail: `ADMIN_PROMETHEUS_BASE_URL is set and /-/healthy ${probeFailure(health, this._config.upstreamTimeoutMs)}. The monitoring compose profile may not be running.`,
            remediation:
              'Check that COMPOSE_PROFILES includes monitoring in deployment/.env and that the prometheus container is up.',
            docUrl: DOC.monitoring,
          },
          {
            development: 'advisory',
            staging: 'warning',
            production: 'warning',
          },
          env,
        ),
      ];
    }

    if (await this._prometheusIsScrapingSidecar(baseUrl)) return [];

    return [
      finding(
        {
          id: 'monitoring-prometheus-not-scraping',
          category: 'monitoring',
          title: 'Prometheus is up but not scraping the fleet sidecar',
          detail:
            "Prometheus answered /-/healthy, but its scribear_sidecar scrape target is missing or not up. The Grafana fleet dashboard's data source will be empty.",
          remediation:
            'Check monitoring-sidecar is running and reachable at monitoring-sidecar:80, and that deployment/monitoring/prometheus.yml was not edited to remove the target.',
          docUrl: DOC.monitoring,
        },
        { development: 'advisory', staging: 'warning', production: 'warning' },
        env,
      ),
    ];
  }

  private async _prometheusIsScrapingSidecar(
    baseUrl: string,
  ): Promise<boolean> {
    const response = await this._probe(`${baseUrl}/api/v1/targets`);
    if (!response?.ok) return false;

    interface TargetsResponse {
      data?: {
        activeTargets?: { labels?: { job?: string }; health?: string }[];
      };
    }

    try {
      const body = (await response.json()) as TargetsResponse;
      return (body.data?.activeTargets ?? []).some(
        (t) => t.labels?.job === 'scribear_sidecar' && t.health === 'up',
      );
    } catch {
      return false;
    }
  }

  /**
   * Reachable, and no longer answering to the well-known default admin
   * password.
   *
   * No dashboard-provisioning check here, deliberately: Grafana's dashboard
   * API (`/api/dashboards/uid/...`) requires authentication, same as every
   * other route past `/api/health`, and admin-server holds no real Grafana
   * credential to check it with (see the class doc — that is the whole
   * point). The only credential this check is allowed to try is the
   * well-known default, which by construction only succeeds on exactly the
   * deployments that have *not* changed it — so a dashboard check built on it
   * would read "missing" on every properly-secured deployment, a guaranteed
   * false positive on the good case. Verified live: the earlier version of
   * this check did exactly that.
   *
   * The password check needs no secret at all — it always attempts exactly
   * `admin`/`CHANGEME` over HTTP Basic auth against an authenticated route and
   * reports whether that succeeded, so admin-server never receives (and does
   * not need) `GRAFANA_ADMIN_PASSWORD` itself.
   */
  private async _checkGrafana(
    baseUrl: string,
    env: DeploymentEnv,
  ): Promise<ConfigFinding[]> {
    const health = await this._probe(`${baseUrl}/api/health`);
    if (!health?.ok) {
      return [
        finding(
          {
            id: 'monitoring-grafana-unreachable',
            category: 'monitoring',
            title: 'Grafana is configured but unreachable',
            detail: `ADMIN_GRAFANA_BASE_URL is set and /api/health ${probeFailure(health, this._config.upstreamTimeoutMs)}. The monitoring compose profile may not be running.`,
            remediation:
              'Check that COMPOSE_PROFILES includes monitoring in deployment/.env and that the grafana container is up.',
            docUrl: DOC.monitoring,
          },
          {
            development: 'advisory',
            staging: 'warning',
            production: 'warning',
          },
          env,
        ),
      ];
    }

    const findings: ConfigFinding[] = [];

    const credentials = Buffer.from('admin:CHANGEME').toString('base64');
    const login = await this._probe(`${baseUrl}/api/org`, {
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (login?.ok) {
      findings.push(
        finding(
          {
            id: 'monitoring-grafana-default-password',
            category: 'monitoring',
            title: 'Grafana admin password is still the example placeholder',
            detail:
              'Grafana accepted admin/CHANGEME, the deployment/.env.example placeholder. Anyone who has read the repository can sign in to Grafana as an administrator. Grafana is now proxied through nginx at /grafana/ — reachable from the entire onsite/VPN range, not just loopback — and has no brute-force lockout by default.',
            remediation:
              'Set GRAFANA_ADMIN_PASSWORD in deployment/.env to a high-entropy secret and recreate the grafana container — its admin password is set from GF_SECURITY_ADMIN_PASSWORD only on first start.',
            docUrl: DOC.monitoring,
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

    return findings;
  }

  /**
   * Is `TEST_AUDIO_SERVICE_KEY` actually the key `test-audio-generator` is
   * running with — not just "not the example placeholder" (the static check
   * above), but *live-verified* against the service it authenticates to.
   *
   * A key that is present, non-placeholder, and simply wrong — the operator
   * copied the wrong value, or only one of the two `.env` copies was updated
   * on a redeploy — is invisible to every check that inspects
   * `TEST_AUDIO_SERVICE_KEY` alone; today it reads identically to a correct
   * key right up until an operator presses "Send test audio" on a room and
   * it fails. Shaped like `_checkGrafana`'s password check for the same
   * reason: probe with the gateway already used for real traffic
   * (`TestAudioGatewayService`, injected — the same "the value never leaves
   * the process it authenticates from" discipline `_checkGrafana`'s doc
   * describes) rather than re-deriving the URL/header here, and keep the
   * three outcomes — verified, verified-wrong, and could-not-verify —
   * distinct, the same distinction `probeFailure` exists to preserve for
   * Grafana/Prometheus: a probe that could not run must not read as a pass.
   *
   * `listDevices()` (`GET /devices`) is the cheapest authenticated route the
   * generator exposes — a read, not a job start — so this never triggers an
   * actual test-audio stream just to check a key.
   *
   * Gated on `!isPlaceholder`, same as the local-password check above: a
   * placeholder key is already reported by `secretChecks`, and a placeholder
   * key that happens to be identical on both sides (an operator who copied
   * the *same* placeholder into both `.env` files) would otherwise probe as
   * "verified" and bury the far more important placeholder finding under a
   * reassuring green result.
   */
  private async _checkTestAudioServiceKey(
    env: DeploymentEnv,
  ): Promise<ConfigFinding[]> {
    if (!this._testAudioGatewayService.enabled) return [];
    if (isPlaceholder(this._config.testAudioServiceKey)) return [];

    const result = await this._testAudioGatewayService.listDevices();

    const couldNotVerify = (detail: string): ConfigFinding[] => [
      finding(
        {
          id: 'test-audio-service-key-probe-unavailable',
          category: 'secrets',
          title:
            'Could not verify TEST_AUDIO_SERVICE_KEY against the test audio generator',
          detail,
          remediation:
            'Check that test-audio-generator is running and reachable at TEST_AUDIO_BASE_URL, then re-check.',
        },
        { development: 'advisory', staging: 'warning', production: 'warning' },
        env,
      ),
    ];

    if (result.kind === 'unreachable') {
      return couldNotVerify(
        'TEST_AUDIO_BASE_URL is set and test-audio-generator did not answer GET /devices. TEST_AUDIO_SERVICE_KEY could not be checked either way — this is not a pass.',
      );
    }

    if (result.kind === 'unparseable') {
      return couldNotVerify(
        `test-audio-generator answered GET /devices with HTTP ${String(result.status)} and a body Config Check could not parse. TEST_AUDIO_SERVICE_KEY could not be checked either way — this is not a pass.`,
      );
    }

    if (result.status === 401 || result.status === 403) {
      return [
        finding(
          {
            id: 'test-audio-service-key-mismatch',
            category: 'secrets',
            title:
              'TEST_AUDIO_SERVICE_KEY is rejected by the test audio generator',
            detail: `GET /devices answered HTTP ${String(result.status)}. TEST_AUDIO_SERVICE_KEY is set and is not the example placeholder, but does not match test-audio-generator's own copy — every "Send test audio" attempt for a room will fail, indistinguishable from the room page alone from the generator being down.`,
            remediation:
              "Set TEST_AUDIO_SERVICE_KEY in deployment/.env to match test-audio-generator's own TEST_AUDIO_SERVICE_KEY (its inbound key), then recreate both containers.",
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

    if (result.status >= 200 && result.status < 300) return [];

    // Any other status the generator could actually answer with (5xx, an
    // unexpected 4xx) is a service that answered but not usably — same
    // "could not verify" bucket as unreachable/unparseable, not a pass and
    // not a confirmed mismatch either.
    return couldNotVerify(
      `test-audio-generator answered GET /devices with HTTP ${String(result.status)}, neither the 200 a valid key produces nor the 401/403 a rejected one would. TEST_AUDIO_SERVICE_KEY could not be checked either way — this is not a pass.`,
    );
  }

  /**
   * Is `db-backup` (deployment/compose.yml v10) actually completing, and is a
   * copy leaving this host.
   *
   * `db-backup` has no HTTP surface to probe like every other dependency
   * above — it is a cron loop, not a service — so this reads the one channel
   * that exists: the bind-mounted directory both containers share.
   * `backupDirectoryService` reports the newest `*.dump` file's age, or
   * `null` when none exists yet. Both "db-backup has never run" and "the bind
   * mount is missing" read as `null` to that class, and are reported the same
   * way here — an operator's next step (check the container) is the same
   * either way.
   *
   * The staleness threshold — `backupIntervalSeconds` plus an hour of grace —
   * mirrors `infra/scribear-db/backup-healthcheck.sh` exactly, so this
   * finding and that container's `docker compose ps` health status agree.
   *
   * Off-host copy is checked directly rather than inferred, unlike most of
   * this page: `BACKUP_OFFSITE_METHOD` is admin-server's own environment
   * variable (passed through unchanged, never a secret), not another
   * service's. `none` is reported as advisory/warning rather than left
   * silent, the same "worth a nudge, not a defect" treatment
   * `monitoring-not-configured` gets — a deployment that has never lost a
   * host has not yet learned why this matters.
   *
   * `backupEnabled: false` short-circuits everything else below: a
   * deployment on managed Postgres (RDS and similar) that has deliberately
   * turned db-backup off is not missing a backup, and reporting
   * `backup-none-found` at it forever would be exactly the false alarm this
   * variable exists to prevent.
   */
  private async _checkBackup(env: DeploymentEnv): Promise<ConfigFinding[]> {
    if (!this._config.backupEnabled) {
      return [
        finding(
          {
            id: 'backup-disabled',
            category: 'backups',
            title: 'Automated Postgres backups are disabled',
            detail:
              'BACKUP_ENABLED is false, so db-backup is idling rather than dumping. Expected for a deployment on managed Postgres with its own backup mechanism.',
            remediation:
              'No action needed if another backup mechanism covers this database. Otherwise set BACKUP_ENABLED=true in deployment/.env.',
            docUrl: DOC.postgres,
          },
          {
            development: 'advisory',
            staging: 'advisory',
            production: 'advisory',
          },
          env,
        ),
      ];
    }

    const findings: ConfigFinding[] = [];

    if (this._config.backupOffsiteMethod === 'none') {
      findings.push(
        finding(
          {
            id: 'backup-offsite-not-configured',
            category: 'backups',
            title: 'Off-host backup copy is not configured',
            detail:
              'BACKUP_OFFSITE_METHOD is "none", so Postgres backups are kept only on this host and do not survive losing it.',
            remediation:
              'Set BACKUP_OFFSITE_METHOD to scp or rsync in deployment/.env — see deployment/UPGRADING.md.',
            docUrl: DOC.postgres,
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

    const ageMs = await this._backupDirectoryService.newestDumpAgeMs();

    if (ageMs === null) {
      findings.push(
        finding(
          {
            id: 'backup-none-found',
            category: 'backups',
            title: 'No Postgres backup has completed yet',
            detail:
              'No .dump file was found under the backup directory. Expected for the first BACKUP_INTERVAL_SECONDS after this stack was brought up; otherwise db-backup may not be running, or its backup volume may not be mounted the same way here.',
            remediation:
              'Check `docker compose ps db-backup` and `docker compose logs db-backup`.',
            docUrl: DOC.postgres,
          },
          {
            development: 'advisory',
            staging: 'warning',
            production: 'warning',
          },
          env,
        ),
      );
      return findings;
    }

    const maxAgeMs = (this._config.backupIntervalSeconds + 3600) * 1000;
    if (ageMs > maxAgeMs) {
      const ageHours = Math.round(ageMs / (60 * 60 * 1000));
      findings.push(
        finding(
          {
            id: 'backup-stale',
            category: 'backups',
            title: 'Postgres backups have stopped completing',
            detail: `The newest backup is ${String(ageHours)}h old, older than the configured BACKUP_INTERVAL_SECONDS (${String(this._config.backupIntervalSeconds)}s) plus an hour of grace. db-backup may be failing silently.`,
            remediation:
              "Check `docker compose logs db-backup` and db-backup's health status in `docker compose ps`.",
            docUrl: DOC.postgres,
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

    return findings;
  }

  /**
   * Reads node-server's self-reported classification of the four secrets
   * admin-server has no way to see directly — JWT_SECRET, NODE_SERVER_KEY,
   * NODE_SERVER_SERVICE_KEY, TRANSCRIPTION_API_KEY (PLAN-ConfigCheck-Coverage
   * Phase 2) — relayed through the monitoring sidecar's
   * `/api/monitoring/v1/config-audit`, which already holds the key
   * node-server's status endpoint requires. admin-server never receives (and
   * does not need) any of these four secrets themselves — the same "probe,
   * don't acquire" discipline `_checkGrafana`'s password check already
   * follows.
   *
   * Unlike the Grafana/Prometheus checks above, this is never gated on an
   * optional profile: the sidecar is a core service, and all four secrets are
   * live in every deployment regardless of whether `monitoring` is on.
   *
   * Three outcomes, deliberately distinct, because collapsing them is how a
   * console ends up implying a clean deployment it never managed to inspect:
   *
   * - the **sidecar** did not answer → `monitoring-sidecar-unreachable`. The
   *   sidecar is the failure, not node-server, and it is the failure for the
   *   alerts panel too;
   * - the sidecar answered that **it** cannot currently vouch for node-server
   *   → `secret-placeholder-audit-unavailable`, except for the one reason
   *   that is not an outage at all (see `node-server-service-key-mismatch`);
   * - the sidecar answered with a classification → the per-secret findings.
   */
  private async _checkSecretPlaceholders(
    env: DeploymentEnv,
  ): Promise<ConfigFinding[]> {
    const response = await this._probe(
      `${this._config.monitoringSidecarBaseUrl}/api/monitoring/v1/config-audit`,
    );

    const unavailable = (detail: string): ConfigFinding[] => [
      finding(
        {
          id: 'secret-placeholder-audit-unavailable',
          category: 'secrets',
          title: 'Could not check node-server-held secrets for placeholders',
          detail,
          // Verified live: a placeholder NODE_SERVER_SERVICE_KEY produces
          // exactly this finding, never `node-server-service-key-placeholder`
          // — node-server's ServiceAuthService refuses to construct at all
          // once its own inbound key contains CHANGEME (fails closed by
          // design, so a misconfigured deployment fails loudly rather than
          // serving telemetry to anyone), which means /status itself 500s
          // before it can ever self-report on that specific key. Named here
          // so an operator does not have to discover it by reading logs.
          remediation:
            'Check `docker compose logs node-server`. A node-server that refuses to start is the usual cause: it fails closed when NODE_SERVER_SERVICE_KEY is empty or still the deployment/.env.example placeholder, so it can never self-report on that particular key — which this check cannot distinguish from an unrelated outage.',
          docUrl: DOC.deployment,
        },
        { development: 'advisory', staging: 'warning', production: 'warning' },
        env,
      ),
    ];

    if (!response?.ok) return this._sidecarUnreachable(response, env);

    // Parsing and shape-validating are both failures of the same kind from a
    // caller's point of view — "the sidecar cannot currently vouch for this" —
    // and neither may throw uncaught out of a `Promise.all` member, which
    // would 500 the whole report over one check that has its own dedicated
    // unavailable state to report instead. The shape check is `Value.Check`
    // over the whole body rather than a `'nodeServer' in parsed` guard: the
    // fields below are dereferenced unconditionally, so a partial match (a
    // `nodeServer` with no `secretPlaceholders`, or a `secretPlaceholders`
    // with no fields) would otherwise either throw here or, worse, read every
    // flag as `undefined` and report a malformed sidecar as a clean deployment.
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return unavailable(
        "monitoring-sidecar's /api/monitoring/v1/config-audit answered with a body Config Check could not parse.",
      );
    }

    if (!Value.Check(CONFIG_AUDIT_RESPONSE_SCHEMA, parsed)) {
      return unavailable(
        "monitoring-sidecar's /api/monitoring/v1/config-audit answered with a body Config Check does not recognize — the sidecar may be a different version than admin-server. JWT_SECRET, NODE_SERVER_KEY, NODE_SERVER_SERVICE_KEY and TRANSCRIPTION_API_KEY could not be checked.",
      );
    }

    const body: ConfigAuditResponse = parsed;

    if (body.nodeServer.status !== 'ok') {
      // `unauthorized` is the one reason that is not an outage: node-server
      // answered, and refused the key. That is a *proof* about two
      // configuration values, not an inability to check one — see
      // `_nodeServerServiceKeyMismatch`.
      if (body.nodeServer.reason === SIDECAR_POLL_UNAUTHORIZED) {
        return this._nodeServerServiceKeyMismatch(env);
      }
      return unavailable(
        `monitoring-sidecar reports node-server status "${body.nodeServer.reason}" — JWT_SECRET, NODE_SERVER_KEY, NODE_SERVER_SERVICE_KEY and TRANSCRIPTION_API_KEY could not be checked.`,
      );
    }

    const sp = body.nodeServer.secretPlaceholders;
    const checks: {
      id: string;
      flagged: boolean;
      variable: string;
      consequence: string;
    }[] = [
      {
        id: 'jwt-secret-placeholder',
        flagged: sp.sessionTokenSigningKeyIsPlaceholder,
        variable: 'JWT_SECRET',
        consequence: 'Every session token is forgeable.',
      },
      {
        id: 'node-server-key-placeholder',
        flagged: sp.sessionManagerServiceApiKeyIsPlaceholder,
        variable: 'NODE_SERVER_KEY',
        consequence:
          'The shared service-to-service key between node-server and session-manager is public.',
      },
      {
        id: 'node-server-service-key-placeholder',
        flagged: sp.nodeServerServiceApiKeyIsPlaceholder,
        variable: 'NODE_SERVER_SERVICE_KEY',
        consequence:
          "The key guarding node-server's own status endpoint — the one this very check reads through the sidecar — is public.",
      },
      {
        id: 'transcription-api-key-placeholder',
        flagged: sp.transcriptionServiceApiKeyIsPlaceholder,
        variable: 'TRANSCRIPTION_API_KEY',
        consequence:
          'The shared key between node-server and transcription-service is public.',
      },
    ];

    return checks
      .filter((c) => c.flagged)
      .map((c) =>
        finding(
          {
            id: c.id,
            category: 'secrets',
            title: `${c.variable} is still the example placeholder`,
            detail: `node-server reports ${c.variable} is still deployment/.env.example's CHANGEME placeholder. ${c.consequence}`,
            remediation: `Set ${c.variable} in deployment/.env to a high-entropy secret and recreate node-server (and session-manager/transcription-service, which also hold it) — see deployment/UPGRADING.md.`,
            docUrl: DOC.deployment,
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

  /**
   * The monitoring sidecar itself did not answer.
   *
   * First-class rather than a shade of "could not check node-server's
   * secrets", which is how it used to be reported and which named the wrong
   * subject: the sidecar is a core service that nothing else on this page
   * covers — it is deliberately absent from `HealthCheckerService`'s probe
   * targets, so `services-unreachable` never mentions it — and when it is
   * down the console's alerts panel goes blank at the same moment, for the
   * same reason. An operator reading "could not check node-server-held
   * secrets" went looking at node-server, which was fine.
   *
   * The detail enumerates what is now *unknown* rather than leaving it
   * implied. This is the same discipline the alerts panel adopted ("no alerts
   * firing" and "we could not ask" are different sentences), and it matters
   * more here because this check is the only thing that would have reported
   * `node-server-service-key-mismatch`: if the sidecar is down, that pair is
   * unverified, and saying nothing would read as agreement.
   */
  private _sidecarUnreachable(
    response: Response | null,
    env: DeploymentEnv,
  ): ConfigFinding[] {
    return [
      finding(
        {
          id: 'monitoring-sidecar-unreachable',
          category: 'monitoring',
          title: 'The monitoring sidecar is not answering',
          detail: `monitoring-sidecar's /api/monitoring/v1/config-audit ${probeFailure(response, this._config.upstreamTimeoutMs)}. While it is down this console cannot show alerts, and three things go unchecked rather than confirmed: node-server's classification of JWT_SECRET, NODE_SERVER_KEY, NODE_SERVER_SERVICE_KEY and TRANSCRIPTION_API_KEY; whether the sidecar and node-server agree on NODE_SERVER_SERVICE_KEY; and every fleet metric Prometheus scrapes from it.`,
          remediation:
            'Check `docker compose ps monitoring-sidecar` and `docker compose logs monitoring-sidecar`, and that ADMIN_MONITORING_SIDECAR_BASE_URL points at it on the backend network (monitoring-sidecar:80 by default).',
          docUrl: DOC.monitoring,
        },
        { development: 'advisory', staging: 'warning', production: 'warning' },
        env,
      ),
    ];
  }

  /**
   * node-server refused the sidecar's key: the two copies of
   * `NODE_SERVER_SERVICE_KEY` are different.
   *
   * This is the one *agreement* fact the deployment can already prove without
   * anyone moving a secret, and it is proved the only way agreement is ever
   * provable here — by a party that holds one copy presenting it to the party
   * that holds the other, and reporting what came back. The sidecar polls
   * node-server's `/status` with its `NODE_SERVER_SERVICE_API_KEY` every
   * `NODE_STATUS_INTERVAL_SEC`; a 401 or 403 becomes the `unauthorized` poll
   * reason, which `/config-audit` relays verbatim. Config Check reads it and
   * says which two things disagree, rather than reporting the same string as
   * one more way of not knowing.
   *
   * A rejection really is proof and not a guess, because both other
   * explanations are closed off: node-server's `ServiceAuthService` refuses to
   * construct when its own inbound key is empty or still `CHANGEME`, so a
   * node-server that answers at all has a usable key, and the sidecar does not
   * poll at all when its own copy is empty (it reports `disabled` instead).
   * What remains is two different non-empty values — which is exactly the
   * class of fault a placeholder check can never see.
   */
  private _nodeServerServiceKeyMismatch(env: DeploymentEnv): ConfigFinding[] {
    return [
      finding(
        {
          id: 'node-server-service-key-mismatch',
          category: 'secrets',
          title:
            'monitoring-sidecar and node-server disagree on NODE_SERVER_SERVICE_KEY',
          detail:
            "node-server rejected the sidecar's status poll as unauthorized, so the two containers hold different values for NODE_SERVER_SERVICE_KEY — usually one of them was recreated after the .env changed and the other was not. Both values are real secrets rather than placeholders, so nothing else on this page reports them. While they disagree the sidecar publishes no node-server telemetry at all: the fleet dashboard's connection, upstream, auth and latency series stay empty, every alert rule built on them can never fire, and the secret classification above cannot be read.",
          remediation:
            'Set one NODE_SERVER_SERVICE_KEY in deployment/.env, then recreate both containers together: `docker compose up -d node-server monitoring-sidecar`. Restarting only one leaves them disagreeing.',
          docUrl: DOC.deployment,
        },
        { development: 'advisory', staging: 'warning', production: 'critical' },
        env,
      ),
    ];
  }

  /**
   * Does session-manager accept the admin key this console presents?
   *
   * The second pair the deployment can prove today, and by the same mechanism
   * as `_nodeServerServiceKeyMismatch`: admin-server holds one copy of
   * `SESSION_MANAGER_API_KEY` and session-manager holds the other, so asking
   * an admin-key-protected route and reading the status *is* the comparison.
   * No secret is moved and no new credential is needed — this is the key the
   * gateway already presents on every page of the console.
   *
   * Its own check rather than a branch of `_checkSharedSchemaVersion`, which
   * makes the same call: that one is reached only after `dbClient.ping()`
   * succeeds, so on a deployment whose Postgres is also down — the case where
   * an operator most needs to know which faults are separate — a rejected
   * admin key would go unmentioned. It costs one extra `GET` on a page that
   * already makes several, and the endpoint is the cheapest authenticated
   * read session-manager has.
   *
   * Deliberately silent in two cases. An empty `ADMIN_API_KEY` is reported by
   * `admin-api-key-missing` instead, which is the better sentence for it (and
   * would otherwise produce two findings for one mistake). A session-manager
   * that does not answer at all is reported by `services-unreachable`; only an
   * actual 401/403 — session-manager answering, and refusing — is evidence
   * about the key.
   */
  private async _checkSessionManagerKey(
    env: DeploymentEnv,
  ): Promise<ConfigFinding[]> {
    if (this._config.adminApiKey === '') return [];

    let status: number | undefined;
    try {
      const [response] =
        await this._sessionManagerGatewayService.getSchemaStatus({
          signal: AbortSignal.timeout(this._config.upstreamTimeoutMs),
        });
      status = response?.status;
    } catch {
      // Unreachable, timed out, or an unreadable body. Not evidence about the
      // key, and already reported by the health rollup.
      return [];
    }

    if (status !== 401 && status !== 403) return [];

    return [
      finding(
        {
          id: 'session-manager-admin-key-mismatch',
          category: 'secrets',
          title:
            'admin-server and session-manager disagree on SESSION_MANAGER_API_KEY',
          detail: `session-manager answered HTTP ${String(status)} to this console's admin key, so the two containers hold different values for SESSION_MANAGER_API_KEY (admin-server reads it as ADMIN_API_KEY). session-manager refuses to start when its own copy is empty or still the CHANGEME placeholder, so both values are real secrets that simply differ — usually one container was recreated after the .env changed and the other was not. Until they match, every page of this console that lists or edits rooms, devices, schedules or sessions answers 502 BACKEND_MISCONFIGURATION.`,
          remediation:
            'Set one SESSION_MANAGER_API_KEY in deployment/.env, then recreate both containers together: `docker compose up -d admin-server session-manager`. Restarting only one leaves them disagreeing.',
          docUrl: DOC.deployment,
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
   *
   * Past the reachability gate there are two independent schemas to report on and
   * both are: admin-server's own audit tables, which it migrates itself at
   * startup, and the shared schema `infra/scribear-db` owns, which the
   * `db-migrate` job applies. They fail separately and are fixed separately.
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

    const findings: ConfigFinding[] = [];

    if (!(await this._databaseHasSchema())) {
      findings.push(
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
      );
    }

    findings.push(...(await this._checkSharedSchemaVersion(env)));

    return findings;
  }

  /**
   * Is the shared schema at the version the running containers were built
   * against?
   *
   * This is the check that closes the gap the rest of the page could only hint
   * at. Until migrations ran inside the stack, applying them was a separate
   * manual step against a database no service could vouch for, and getting it
   * wrong showed up as `services-failing` with a `database: fail` — a symptom
   * three inferences away from "migrations were never run". Here the question is
   * asked directly, and asked of two independent sources:
   *
   * - the **database**, read through `readSchemaState`, which says what has
   *   actually been applied;
   * - the **session-manager container**, which says what schema the code
   *   currently serving traffic was compiled against.
   *
   * Comparing the second against admin-server's own build is the only way to see
   * a half-finished upgrade, where one service was pulled and another was not.
   * Nothing else in the stack can observe that: every service knows its own
   * version and no service knows anyone else's.
   */
  private async _checkSharedSchemaVersion(
    env: DeploymentEnv,
  ): Promise<ConfigFinding[]> {
    const [state, reportedLatest] = await Promise.all([
      this._readSharedSchemaState(),
      this._readSessionManagerSchemaVersion(),
    ]);

    if (state === null) {
      // The migration table could not be read on a database that answered
      // `SELECT 1`. Almost always a permissions problem, and reporting it as
      // "never migrated" would send an operator to run migrations that would
      // fail for the same reason.
      return [
        finding(
          {
            id: 'schema-version-unreadable',
            category: 'services',
            title: 'The applied schema version could not be read',
            detail: `The database answered, but reading ${MIGRATION_TABLE} failed. Usually DB_USER lacks rights on the public schema.`,
            remediation:
              'Check that DB_USER in deployment/.env owns (or can read) the ScribeAR database, then re-check.',
            docUrl: DOC.postgres,
          },
          {
            development: 'advisory',
            staging: 'warning',
            production: 'warning',
          },
          env,
        ),
      ];
    }

    const findings: ConfigFinding[] = [];

    if (!state.initialized) {
      findings.push(
        finding(
          {
            id: 'schema-never-migrated',
            category: 'services',
            title: 'The database has never been migrated',
            detail: `${MIGRATION_TABLE} does not exist, so none of the ${String(state.expected.length)} migrations this deployment ships have been applied. session-manager cannot serve anything and is failing its readiness probe.`,
            remediation:
              'Run `docker compose up -d` in deployment/ — the db-migrate job applies the schema before the services start. To apply migrations on their own, run deployment/run-migrator.sh.',
            docUrl: DOC.migrations,
          },
          {
            development: 'critical',
            staging: 'critical',
            production: 'critical',
          },
          env,
        ),
      );
    } else if (state.pending.length > 0) {
      findings.push(
        finding(
          {
            id: 'schema-migrations-pending',
            category: 'services',
            title: `${String(state.pending.length)} database migration(s) have not been applied`,
            detail: `The database is at ${state.latestApplied || 'no migration'} and this deployment expects ${state.latestExpected}. First unapplied: ${state.pending[0] ?? ''}. session-manager fails its readiness probe until they are applied, so the stack is only partly serving.`,
            remediation:
              'Run `docker compose up -d` in deployment/, or deployment/run-migrator.sh to apply them without touching the running services.',
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

    if (state.unknown.length > 0) {
      findings.push(
        finding(
          {
            id: 'schema-ahead-of-containers',
            category: 'services',
            title: 'The database schema is newer than the running images',
            detail: `${String(state.unknown.length)} applied migration(s) are unknown to this build, the newest being ${state.unknown[state.unknown.length - 1] ?? ''}. This is what a rollback looks like: the images were moved back and the schema was not. Nothing is broken as long as the older code's queries still fit the newer schema.`,
            remediation:
              'Expected after a rollback. If it was not deliberate, check IMAGE_TAG in deployment/.env against the version the database was migrated to.',
            docUrl: DOC.migrations,
          },
          {
            development: 'advisory',
            staging: 'warning',
            production: 'warning',
          },
          env,
        ),
      );
    }

    // Skipped rather than guessed at when session-manager did not answer:
    // `services-unreachable` already reports that, and two findings for one cause
    // is the pattern this page avoids.
    if (reportedLatest !== null && reportedLatest !== LATEST_MIGRATION) {
      findings.push(
        finding(
          {
            id: 'schema-version-skew',
            category: 'services',
            title: 'The containers disagree about the schema version',
            detail: `session-manager expects ${reportedLatest || 'no migrations'} and admin-server was built against ${LATEST_MIGRATION}. Every service in a deployment should come from one IMAGE_TAG, so this means an upgrade only partly completed — and it makes the pending-migration counts above unreliable, since they are measured against admin-server's idea of the schema.`,
            remediation:
              'Run `docker compose up -d` in deployment/ to pull every service to the same IMAGE_TAG, then re-check.',
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

    return findings;
  }

  /** Applied-vs-expected migrations, or null when the table cannot be read. */
  private async _readSharedSchemaState(): Promise<SchemaState | null> {
    try {
      return await this._dbClient.scribearSchemaState();
    } catch {
      return null;
    }
  }

  /**
   * The schema version session-manager reports, or null when it could not be
   * asked — unreachable, timed out, or rejecting admin-server's key. All three
   * are already reported by other checks, so they are not re-diagnosed here.
   */
  private async _readSessionManagerSchemaVersion(): Promise<string | null> {
    try {
      const [response] =
        await this._sessionManagerGatewayService.getSchemaStatus({
          signal: AbortSignal.timeout(this._config.upstreamTimeoutMs),
        });
      if (response?.status !== 200) return null;
      return response.data.latestExpected;
    } catch {
      return null;
    }
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
