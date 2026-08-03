import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect } from 'vitest';

import { EXPECTED_COMPOSE_FILE_VERSION } from '#src/server/features/deployment-versions/deployment-versions.service.js';

/**
 * Drift guard for the compose-file version check.
 *
 * The check compares a literal in `deployment/compose.yml` against a constant
 * in this image, which only works while a human keeps the two in step — and a
 * version number nobody remembers to bump is worse than no version number at
 * all, because it reports a match that was never verified.
 *
 * So this suite fails on any change to `deployment/compose.yml`, not only on a
 * mismatch. The author then makes the one call this scheme needs and cannot
 * make for itself: is this a change operators must redeploy for? Re-pinning the
 * hash is a deliberate act with a message next to it, rather than something
 * that happens silently.
 *
 * A regex rather than a YAML parser deliberately: neither this workspace nor
 * the repo has one, and the literal is matched at a fixed indentation inside a
 * block this guard also hashes, so a change that moves it fails here rather
 * than parsing to something wrong.
 */

const COMPOSE_FILE = 'deployment/compose.yml';

/**
 * sha256 of `deployment/compose.yml`, as committed.
 *
 * Re-pin it whenever that file changes — see the failure message below for
 * which of the two remedies applies.
 */
const COMPOSE_FILE_SHA256 =
  '72170e47cf283ef18fc64448435463cb5bf51c3421f359ab172ae3bcee2b2a4c';

/** Walks up from the working directory, which differs by how vitest was run. */
function repoFile(relative: string): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate ${relative} above ${process.cwd()}`);
    }
    dir = parent;
  }
}

/**
 * Reads `COMPOSE_FILE_VERSION: "<n>"` out of the compose file.
 *
 * Throws rather than returning null if it is gone or has changed shape: a drift
 * guard that can silently stop guarding is worse than no guard at all. The
 * quotes are required by the pattern because an unquoted `1` is a YAML integer,
 * and compose refuses to start a stack whose environment value is not a string.
 */
function composeFileVersion(source: string): number {
  const match = /^\s*COMPOSE_FILE_VERSION:\s*"(\d+)"\s*$/m.exec(source);
  if (!match?.[1]) {
    throw new Error(
      `Could not read \`COMPOSE_FILE_VERSION: "<n>"\` from ${COMPOSE_FILE}. ` +
        `It must stay a quoted integer literal — never a \`\${...}\` ` +
        `interpolation, which would let a stale .env vouch for the compose ` +
        `file. If the declaration moved, update this guard rather than ` +
        `deleting it.`,
    );
  }
  return Number(match[1]);
}

describe('deployment/compose.yml version', (it) => {
  const path = repoFile(COMPOSE_FILE);
  const bytes = readFileSync(path);
  const source = bytes.toString('utf8');

  it('declares the version this admin-server image expects', () => {
    // Act
    const declared = composeFileVersion(source);

    // Assert — these two are the whole check. If they disagree here, every
    // deployment built from this commit reports a mismatch it does not have,
    // and the one real mismatch it exists to catch becomes unreadable.
    expect(
      declared,
      `${COMPOSE_FILE} declares COMPOSE_FILE_VERSION ${String(declared)}, but ` +
        `admin-server's EXPECTED_COMPOSE_FILE_VERSION is ` +
        `${String(EXPECTED_COMPOSE_FILE_VERSION)}. Both must move together: ` +
        `bump the literal in ${COMPOSE_FILE} and the constant in ` +
        `apps/admin-server/src/server/features/deployment-versions/` +
        `deployment-versions.service.ts.`,
    ).toBe(EXPECTED_COMPOSE_FILE_VERSION);
  });

  it('has not changed since the version was last considered', () => {
    // Act
    const actual = createHash('sha256').update(bytes).digest('hex');

    // Assert — the pin is what makes the version number trustworthy: without
    // it, a compose change that needed a bump would ship with the old number
    // and every deployment would be told it is up to date.
    expect(
      actual,
      `${COMPOSE_FILE} has changed since its hash was pinned.\n\n` +
        `  new sha256: ${actual}\n\n` +
        `Decide which kind of change it is, then update this test:\n\n` +
        `  * Operators must redeploy for it — a new or removed service, a new, ` +
        `renamed or re-defaulted environment variable, changed wiring, ports ` +
        `or volumes. Bump COMPOSE_FILE_VERSION in ${COMPOSE_FILE} AND ` +
        `EXPECTED_COMPOSE_FILE_VERSION in ` +
        `apps/admin-server/src/server/features/deployment-versions/` +
        `deployment-versions.service.ts, then re-pin the hash above. Add a ` +
        `note to deployment/UPGRADING.md while you are there.\n\n` +
        `  * They do not — a comment, a doc link, formatting. Re-pin the hash ` +
        `above and leave both versions where they are.\n\n` +
        `Bumping when in doubt is the cheap mistake: it costs an operator one ` +
        `\`docker compose up -d\` they did not strictly need.`,
    ).toBe(COMPOSE_FILE_SHA256);
  });
});
