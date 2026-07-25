/**
 * Where the image a container is running came from.
 *
 * - `ci` — built and published by a GitHub Actions run. The only origin whose
 *   commit can be trusted to exist on a branch someone else can check out.
 * - `local` — built on someone's machine by `build-containers.sh`. The commit
 *   is real, but the image was never published, so two boxes reporting the same
 *   commit are not necessarily running the same bytes.
 * - `unknown` — nothing stamped the build. Either a hand-rolled `docker build`,
 *   or a process started straight from a checkout (`npm run dev`), where there
 *   is no image at all.
 *
 * Kept distinct from `dirty` deliberately: a CI build is never dirty, but a
 * clean local build is still a local build, and an operator chasing "why does
 * staging not match main" needs to know which of those they are looking at.
 */
export type BuildOrigin = 'ci' | 'local' | 'unknown';

/**
 * What a running container can say about the artifact it was built from.
 *
 * Every field is baked in at image build time (see each service's Dockerfile)
 * and read back from the environment here. Nothing is derived at runtime, which
 * is the point: an operator asking "what is actually deployed?" needs the
 * identity of the *image*, not of the source tree the container happens to be
 * sitting next to.
 *
 * The same shape is produced by every container in the stack, including the
 * ones that are not Node services — the webapps ship it as a static
 * `build-info.json` and transcription-service builds it in Python — so the
 * admin console can render one table rather than one renderer per language.
 */
export interface BuildInfo {
  /** Compose service name, matching the health rollup's component names. */
  service: string;
  /** Version from the image's `package.json` / `pyproject.toml`. */
  version: string;
  /** Full commit SHA the image was built from, without any `-dirty` suffix. */
  commit: string;
  /** Branch or tag the build ran on, e.g. `staging`. */
  ref: string;
  /** ISO 8601 instant the image was built. */
  builtAt: string;
  /** Registry tags this image was published under, e.g. `staging`, `v1.4.2`. */
  imageTags: string[];
  /** Pull request the image was built from, or null outside a PR build. */
  pullRequest: number | null;
  origin: BuildOrigin;
  /**
   * True when the working tree had uncommitted changes at build time, so
   * `commit` names a commit the image does *not* faithfully contain.
   */
  dirty: boolean;
}

/**
 * Stand-in for a field the build did not supply.
 *
 * A literal rather than an empty string or `null` so that a locally-built image
 * reads as "built outside CI" everywhere it is displayed, instead of as a blank
 * cell that could equally mean the request failed.
 */
export const UNKNOWN_BUILD_FIELD = 'unknown';

/**
 * Suffix `build-containers.sh` appends to a commit built from a working tree
 * with uncommitted changes, following the `git describe --dirty` convention.
 *
 * Carried in the commit string rather than in a build arg of its own so that
 * `org.opencontainers.image.revision` — which an operator reads with
 * `docker inspect`, far from this code — says so too.
 */
const DIRTY_SUFFIX = '-dirty';

function readField(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? UNKNOWN_BUILD_FIELD : trimmed;
}

function readOrigin(value: string | undefined): BuildOrigin {
  const trimmed = value?.trim().toLowerCase() ?? '';
  return trimmed === 'ci' || trimmed === 'local' ? trimmed : 'unknown';
}

/**
 * Parses a PR number, or null when there was not one.
 *
 * Anything unparseable is null rather than `NaN` or a thrown error: this is
 * decoration on a page whose job is to work when the deployment does not.
 */
function readPullRequest(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Reads the `SCRIBEAR_BUILD_*` variables the Dockerfile bakes in.
 *
 * Tolerant by construction — every field falls back to `unknown` rather than
 * throwing. This runs on the way to answering an operator's "what is deployed?"
 * question, and a container that cannot describe itself must still start and
 * still answer, or the one situation the page exists for (a half-finished
 * upgrade) is also the situation where it goes blank.
 */
export function readBuildInfo(
  env: Record<string, string | undefined> = process.env,
): BuildInfo {
  // Indexed rather than dot-accessed: `noPropertyAccessFromIndexSignature` is
  // on, and one accessor reads better than a bracket on every line.
  const get = (name: string): string | undefined => env[name];

  const rawCommit = readField(get('SCRIBEAR_BUILD_COMMIT'));
  const dirty = rawCommit.endsWith(DIRTY_SUFFIX);

  const tags = (get('SCRIBEAR_BUILD_TAGS') ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');

  return {
    service: readField(get('SCRIBEAR_BUILD_SERVICE')),
    version: readField(get('SCRIBEAR_BUILD_VERSION')),
    commit: dirty ? rawCommit.slice(0, -DIRTY_SUFFIX.length) : rawCommit,
    ref: readField(get('SCRIBEAR_BUILD_REF')),
    builtAt: readField(get('SCRIBEAR_BUILD_TIME')),
    imageTags: tags,
    pullRequest: readPullRequest(get('SCRIBEAR_BUILD_PR')),
    origin: readOrigin(get('SCRIBEAR_BUILD_ORIGIN')),
    dirty,
  };
}
