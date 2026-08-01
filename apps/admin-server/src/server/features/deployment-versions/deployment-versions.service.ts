import type { BuildInfo } from '@scribear/base-fastify-server';
import {
  UNKNOWN_BUILD_FIELD,
  readBuildInfo,
} from '@scribear/base-fastify-server';

/**
 * Outcome of asking one container what it was built from.
 *
 * - `ok` — answered with a build document.
 * - `unsupported` — answered, and does not have the route. The container is
 *   running an image from before build reporting existed, which is itself the
 *   answer: it is older than this admin-server and has not been recreated.
 * - `unreachable` — no answer, or an answer nothing could be made of.
 * - `not-reported` — has no way to report and is not expected to. Postgres and
 *   Redis speak neither HTTP nor anything else this console could ask.
 *
 * `unsupported` is kept apart from `unreachable` deliberately. They look
 * identical from the socket up (both are "no build document"), and they mean
 * opposite things to an operator: one container is stale, the other is down.
 */
export type VersionProbeStatus =
  | 'ok'
  | 'unsupported'
  | 'unreachable'
  | 'not-reported';

export interface ContainerVersion {
  /** Compose service name, matching the health rollup's component names. */
  service: string;
  status: VersionProbeStatus;
  /** The build document, or null for every status other than `ok`. */
  build: BuildInfo | null;
  /** One line of elaboration when the container did not report. */
  detail?: string | undefined;
}

/**
 * The `compose.yml` this image expects to be run by.
 *
 * Baked in here rather than read from anywhere at runtime, which is the whole
 * mechanism: this number travels inside the image, the number in
 * `deployment/compose.yml` travels with the file, and comparing them is the
 * only way a container can notice that the two were upgraded separately.
 *
 * Bump it — and the literal in `deployment/compose.yml` — whenever a change to
 * that file is one an operator must redeploy for: a new service, a new or
 * renamed environment variable, changed wiring. Leave both alone for a comment
 * or a doc tweak. `tests/unit/features/deployment-versions/compose-file-
 * version.test.ts` fails if the two ever disagree, or if that file changes
 * without someone having made that call.
 */
export const EXPECTED_COMPOSE_FILE_VERSION = 8;

/**
 * How the running `compose.yml` compares to the one this image was built for.
 *
 * - `match` — the file and the images agree.
 * - `stale` — the file is older than the images: someone pulled without
 *   copying the new `deployment/compose.yml`, so services, variables or wiring
 *   the new images expect are simply absent.
 * - `ahead` — the images are older than the file: the file was copied but the
 *   images were not pulled, or only some were.
 * - `unknown` — the file reported nothing, so it predates this check entirely
 *   and is at least that old.
 *
 * `stale` and `ahead` are kept apart even though both are "the deployment is
 * inconsistent", for the same reason `unsupported` and `unreachable` are: the
 * remedy differs. One operator needs to copy a file, the other needs to pull
 * images, and telling either of them only that something is out of step leaves
 * them to guess which.
 *
 * `unknown` is kept apart from both for a different reason: it is not a
 * measured mismatch but the *absence* of a measurement. Reporting it as a
 * mismatch would assert something this check cannot see, and reporting it as a
 * match would be a false all-clear on the one deployment most likely to be out
 * of date — a compose file old enough to predate this variable.
 */
export type ComposeFileStatus = 'match' | 'stale' | 'ahead' | 'unknown';

/** How the running `compose.yml` compares to the one this image expects. */
export interface ComposeFileVersion {
  /** What this image was built for — `EXPECTED_COMPOSE_FILE_VERSION`. */
  expected: number;
  /**
   * What the running compose file said, or null when it said nothing — either
   * because it predates this check, or because it named something that is not
   * a version number, which this check cannot tell apart and does not try to.
   */
  reported: number | null;
  status: ComposeFileStatus;
}

export interface DeploymentVersionsReport {
  containers: ContainerVersion[];
  /**
   * The compose file itself, which is the one part of a deployment that is not
   * an image and therefore never moves when images are pulled.
   */
  composeFile: ComposeFileVersion;
  /**
   * The commit this deployment is taken to be, or null when nothing reported
   * one. Every `mismatched` entry is measured against it.
   */
  expectedCommit: string | null;
  /** Services whose commit is not `expectedCommit`. The headline of the page. */
  mismatched: string[];
  /** Services built on someone's machine rather than by a CI run. */
  locallyBuilt: string[];
  /** Services built from a working tree with uncommitted changes. */
  dirty: string[];
  /**
   * True when containers answered but not one of them knows its own commit —
   * the signature of a stack started straight from a checkout (`npm run dev`,
   * or images built by hand) rather than from published artifacts.
   */
  unstamped: boolean;
  checkedAt: string;
}

/** One container to ask, and where its build document lives. */
export interface VersionProbeTarget {
  name: string;
  /**
   * Absolute URL of the build document. The Node services and
   * transcription-service serve it from a route; the webapps and the reverse
   * proxy serve it as a static `build-info.json`, which is why this is a full
   * URL per target rather than a base URL plus one shared path.
   */
  url: string;
}

/** A container that cannot be asked, and the reason to show instead. */
export interface NonReportingContainer {
  name: string;
  detail: string;
}

export interface DeploymentVersionsConfig {
  /**
   * Per-container timeout. The containers are probed concurrently, so this is
   * also the worst case for the whole table. Kept short: an admin is waiting,
   * and a container that cannot answer in a second is itself the finding.
   */
  timeoutMs: number;
  targets: VersionProbeTarget[];
  nonReporting: NonReportingContainer[];
  /**
   * `COMPOSE_FILE_VERSION` exactly as the environment gave it — a raw string,
   * empty when unset, and not trusted to be a number. It is compared against
   * `EXPECTED_COMPOSE_FILE_VERSION`, never used for anything else.
   */
  reportedComposeFileVersion: string;
}

/**
 * Compares the running compose file's version against this image's.
 *
 * Everything that is not a plain non-negative integer is `unknown` rather than
 * an error: an absent variable, a blank one and a typo all mean the same thing
 * here — nothing can be concluded — and none of them is worth failing a page an
 * operator opened to diagnose a deployment.
 */
export function resolveComposeFileVersion(raw: string): ComposeFileVersion {
  const trimmed = raw.trim();
  const reported = /^\d+$/.test(trimmed) ? Number(trimmed) : null;

  const status: ComposeFileStatus =
    reported === null
      ? 'unknown'
      : reported === EXPECTED_COMPOSE_FILE_VERSION
        ? 'match'
        : reported < EXPECTED_COMPOSE_FILE_VERSION
          ? 'stale'
          : 'ahead';

  return { expected: EXPECTED_COMPOSE_FILE_VERSION, reported, status };
}

/**
 * Narrows a foreign JSON body to a `BuildInfo`.
 *
 * Every field is checked rather than trusted. Four of these documents are
 * produced outside this codebase's type system — one by a Python service, three
 * by a shell script baked into an nginx image — so "it deserialized" is not
 * evidence that it has the shape the console renders. A body that does not fit
 * is treated as no answer at all, which surfaces as `unreachable` with the
 * reason attached, rather than as a row of `undefined`.
 */
function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;

  const service = body['service'];
  const version = body['version'];
  const commit = body['commit'];
  const ref = body['ref'];
  const builtAt = body['builtAt'];
  const imageTags = body['imageTags'];
  const pullRequest = body['pullRequest'];
  const origin = body['origin'];
  const dirty = body['dirty'];

  if (
    typeof service !== 'string' ||
    typeof version !== 'string' ||
    typeof commit !== 'string' ||
    typeof ref !== 'string' ||
    typeof builtAt !== 'string' ||
    typeof dirty !== 'boolean'
  ) {
    return null;
  }

  if (!Array.isArray(imageTags)) return null;
  if (!imageTags.every((tag) => typeof tag === 'string')) return null;

  if (origin !== 'ci' && origin !== 'local' && origin !== 'unknown')
    return null;

  if (pullRequest !== null && typeof pullRequest !== 'number') return null;

  return {
    service,
    version,
    commit,
    ref,
    builtAt,
    imageTags,
    pullRequest,
    origin,
    dirty,
  };
}

/** True when a container reported a commit it actually knows. */
function hasKnownCommit(container: ContainerVersion): boolean {
  return (
    container.status === 'ok' &&
    container.build !== null &&
    container.build.commit !== UNKNOWN_BUILD_FIELD
  );
}

/**
 * The commit the deployment is taken to be: whichever one the most containers
 * report.
 *
 * Modal rather than "whatever admin-server itself is", which was the obvious
 * alternative and reads badly in the common case. When one container is missed
 * by an upgrade, the majority is the intended version and the straggler is the
 * exception — and that stays true whether or not the straggler is the admin
 * console. Anchoring on admin-server would report nine mismatches and one
 * healthy container when it is admin-server that was left behind.
 *
 * Ties break towards admin-server's own commit, which is the only tie-break
 * available that does not depend on probe ordering: a two-versus-two split has
 * no majority to find, and the container rendering the page is at least a
 * commit an operator can identify.
 */
function resolveExpectedCommit(
  containers: ContainerVersion[],
  selfCommit: string,
): string | null {
  const counts = new Map<string, number>();
  for (const container of containers) {
    if (!hasKnownCommit(container)) continue;
    const commit = container.build?.commit ?? '';
    counts.set(commit, (counts.get(commit) ?? 0) + 1);
  }

  let winner: string | null = null;
  let winningCount = 0;
  for (const [commit, count] of counts) {
    const beatsWinner =
      count > winningCount || (count === winningCount && commit === selfCommit);
    if (beatsWinner) {
      winner = commit;
      winningCount = count;
    }
  }

  return winner;
}

/**
 * Answers "what is actually deployed here?" by asking every container.
 *
 * This is the one question no other part of the console can answer. Each
 * service knows its own build and no service knows anyone else's, so a
 * half-finished upgrade — one image pulled, another not — is invisible from
 * inside any single container, including this one. The health rollup would show
 * every component green throughout, because a stale container is a perfectly
 * healthy container.
 *
 * admin-server's own row is read in-process rather than over a loopback
 * request: it is the same value the route would return, and a console that
 * could not reach itself would drop the one row it can always speak for.
 *
 * The compose file is reported alongside them because it is the one part of a
 * deployment that is not an image: pulling images cannot update it, no
 * container can read it, and a stack running new images against an old
 * `compose.yml` is missing services and variables while every row above says
 * `ok`. It is compared by version number rather than read, which is why it is
 * an environment variable — see `EXPECTED_COMPOSE_FILE_VERSION`.
 */
export class DeploymentVersionsService {
  private _config: DeploymentVersionsConfig;

  constructor(deploymentVersionsConfig: DeploymentVersionsConfig) {
    this._config = deploymentVersionsConfig;
  }

  async report(): Promise<DeploymentVersionsReport> {
    const self: ContainerVersion = {
      service: 'admin-server',
      status: 'ok',
      build: readBuildInfo(),
    };

    // Concurrent, for the same reason the health rollup is: sequential probes
    // would make the slowest container set the floor for the whole page.
    const probed = await Promise.all(
      this._config.targets.map((target) => this._probe(target)),
    );

    const nonReporting: ContainerVersion[] = this._config.nonReporting.map(
      (container) => ({
        service: container.name,
        status: 'not-reported' as const,
        build: null,
        detail: container.detail,
      }),
    );

    const containers = [self, ...probed, ...nonReporting];
    const expectedCommit = resolveExpectedCommit(
      containers,
      self.build?.commit ?? UNKNOWN_BUILD_FIELD,
    );

    const reporting = containers.filter((c) => c.status === 'ok');

    return {
      containers,
      // Not probed and not awaited: the compose file cannot be asked anything,
      // so this is a comparison between one environment variable and one
      // constant, and it answers even when every container above is down.
      composeFile: resolveComposeFileVersion(
        this._config.reportedComposeFileVersion,
      ),
      expectedCommit,
      mismatched: containers
        .filter((c) => hasKnownCommit(c) && c.build?.commit !== expectedCommit)
        .map((c) => c.service),
      locallyBuilt: reporting
        .filter((c) => c.build?.origin === 'local')
        .map((c) => c.service),
      dirty: reporting
        .filter((c) => c.build?.dirty === true)
        .map((c) => c.service),
      // Containers answered, and none of them knows what it was built from.
      unstamped: reporting.length > 0 && expectedCommit === null,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Asks one container, mapping every way it can fail onto a status an
   * operator can act on.
   *
   * Raw `fetch` rather than a generated client, and a hard `AbortSignal`
   * timeout on every request — the same reasoning as the health rollup: these
   * are two-field unauthenticated documents, and one hung container must not be
   * able to hold this page open.
   */
  private async _probe(target: VersionProbeTarget): Promise<ContainerVersion> {
    let response: Response;
    try {
      response = await fetch(target.url, {
        signal: AbortSignal.timeout(this._config.timeoutMs),
      });
    } catch (err) {
      return {
        service: target.name,
        status: 'unreachable',
        build: null,
        detail:
          err instanceof Error && err.name === 'TimeoutError'
            ? `no response within ${String(this._config.timeoutMs)}ms`
            : 'connection failed',
      };
    }

    // A 404 from a container that answered at all means the image predates
    // build reporting. That is not a fault to investigate, it is the answer:
    // this container is older than the one asking.
    if (response.status === 404) {
      return {
        service: target.name,
        status: 'unsupported',
        build: null,
        detail:
          'running an image from before build reporting, so it was not recreated by the last upgrade',
      };
    }

    if (!response.ok) {
      return {
        service: target.name,
        status: 'unreachable',
        build: null,
        detail: `HTTP ${String(response.status)}`,
      };
    }

    const body = await response
      .json()
      .then((parsed: unknown) => parsed)
      .catch(() => null);

    const build = parseBuildInfo(body);
    if (build === null) {
      return {
        service: target.name,
        status: 'unreachable',
        build: null,
        detail: 'answered with something that is not a build document',
      };
    }

    return { service: target.name, status: 'ok', build };
  }
}
