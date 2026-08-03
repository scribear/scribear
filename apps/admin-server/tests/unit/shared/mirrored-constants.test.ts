import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect } from 'vitest';

import { AUDIO_STATS_TTL_MS } from '@scribear/scribear-redis';

/**
 * Drift guards for constants that are deliberately duplicated across the
 * browser boundary.
 *
 * `apps/admin-webapp` cannot import `@scribear/scribear-redis` (it pulls in
 * ioredis and has no browser-safe entry point) and has no node types on purpose,
 * so a handful of values are restated there by hand. Restating them is the right
 * call; leaving them unchecked is not — PLAN-AUDIOVIZ §10.4 explicitly expects
 * the audio publish cadence to be retuned once the panel exists, and a stale
 * copy would make the dashboard's staleness warning fire early or never.
 *
 * This suite lives in admin-server because it is the workspace that can both
 * import the real constants and read files. It asserts against the webapp's
 * source text: crude, but it is the only direction that works, and a failure
 * names the exact file and value to update.
 */

const MIRRORS = {
  webappApi: 'apps/admin-webapp/src/lib/admin-api.ts',
  webappRenderFidelity:
    'apps/admin-webapp/tests/features/dashboard/audio-render-fidelity.test.tsx',
  crosscheckFixtures: 'tools/audio-meter-crosscheck/fixtures.json',
} as const;

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

function read(relative: string): string {
  return readFileSync(repoFile(relative), 'utf8');
}

/**
 * Extracts `export const <name> = <number>;` from TypeScript source.
 *
 * Throws rather than returning undefined if the shape changed: a drift guard
 * that can silently stop guarding is worse than no guard at all.
 */
function exportedNumber(source: string, name: string, file: string): number {
  const match = new RegExp(
    `export const ${name}\\s*=\\s*(-?[0-9_.]+)\\s*;`,
  ).exec(source);
  if (!match?.[1]) {
    throw new Error(
      `Could not read \`export const ${name}\` as a numeric literal from ${file}. ` +
        `If the declaration changed shape, update this guard rather than deleting it.`,
    );
  }
  return Number(match[1].replaceAll('_', ''));
}

/** Extracts `const <name> = <number>;` (a local, not an export). */
function localNumber(source: string, name: string, file: string): number {
  const match = new RegExp(`\\bconst ${name}\\s*=\\s*(-?[0-9_.]+)\\s*;`).exec(
    source,
  );
  if (!match?.[1]) {
    throw new Error(
      `Could not read \`const ${name}\` as a numeric literal from ${file}. ` +
        `If the declaration changed shape, update this guard rather than deleting it.`,
    );
  }
  return Number(match[1].replaceAll('_', ''));
}

interface CrosscheckFixtures {
  toleranceDb: number;
  wav: { expected: { rmsDbfs: number } };
  tones: { name: string; expected: { rmsDbfs: number } }[];
}

describe('admin-webapp mirrors of @scribear/scribear-redis', (it) => {
  it('restates AUDIO_STATS_TTL_MS as the publisher actually defines it', () => {
    // Arrange
    const source = read(MIRRORS.webappApi);

    // Act
    const mirrored = exportedNumber(
      source,
      'AUDIO_STATS_TTL_MS',
      MIRRORS.webappApi,
    );

    // Assert — the webapp compares real `updatedAt` timestamps against this to
    // decide whether an audio reading is stale, so a drifted copy is a wrong
    // warning rather than a cosmetic mismatch.
    expect(mirrored).toBe(AUDIO_STATS_TTL_MS);
  });
});

describe('admin-webapp mirrors of the audio cross-check manifest', (it) => {
  const fixtures = JSON.parse(
    read(MIRRORS.crosscheckFixtures),
  ) as CrosscheckFixtures;
  const source = read(MIRRORS.webappRenderFidelity);
  const file = MIRRORS.webappRenderFidelity;

  it('restates the shared tolerance', () => {
    expect(localNumber(source, 'TOLERANCE_DB', file)).toBe(
      fixtures.toleranceDb,
    );
  });

  it('restates the speech excerpt RMS the two meters are pinned to', () => {
    // PLAN-AUDIOVIZ §9's cross-check is only transitive if the render-path leg
    // is measuring the same number the two DSP legs are.
    expect(localNumber(source, 'SPEECH_EXCERPT_RMS_DBFS', file)).toBe(
      fixtures.wav.expected.rmsDbfs,
    );
  });

  it('restates each calibration tone level', () => {
    // Arrange — the manifest's tone levels, in the order the webapp names them.
    const expected = fixtures.tones.map((tone) => tone.expected.rmsDbfs);

    // Act — the webapp's TONE_RMS_DBFS members, read as an object literal.
    const block = /const TONE_RMS_DBFS = \{([\s\S]*?)\}/.exec(source)?.[1];
    if (block === undefined) {
      throw new Error(`Could not find TONE_RMS_DBFS in ${file}`);
    }
    const mirrored = [...block.matchAll(/:\s*(-?[0-9_.]+)/g)].map((m) =>
      Number(m[1]),
    );

    // Assert
    expect(mirrored).toEqual(expected);
  });
});
