import { describe, expect } from 'vitest';

import { UNKNOWN_BUILD_FIELD, readBuildInfo } from '#src/server/build-info.js';

describe('readBuildInfo', (it) => {
  it('reads every field a CI build bakes in', () => {
    // Arrange
    const env = {
      SCRIBEAR_BUILD_SERVICE: 'admin-server',
      SCRIBEAR_BUILD_VERSION: '1.4.2',
      SCRIBEAR_BUILD_COMMIT: 'def6e68f0b3c4a1d9e2f5a7b8c0d1e2f3a4b5c6d',
      SCRIBEAR_BUILD_REF: 'staging',
      SCRIBEAR_BUILD_TIME: '2026-07-24T12:03:11Z',
      SCRIBEAR_BUILD_TAGS: 'staging,staging-def6e68',
      SCRIBEAR_BUILD_ORIGIN: 'ci',
    };

    // Act
    const info = readBuildInfo(env);

    // Assert
    expect(info).toEqual({
      service: 'admin-server',
      version: '1.4.2',
      commit: 'def6e68f0b3c4a1d9e2f5a7b8c0d1e2f3a4b5c6d',
      ref: 'staging',
      builtAt: '2026-07-24T12:03:11Z',
      imageTags: ['staging', 'staging-def6e68'],
      pullRequest: null,
      origin: 'ci',
      dirty: false,
    });
  });

  // A stack started straight from a checkout (`npm run dev`) has no image and
  // so stamps nothing. It must still describe itself, and must do so in a way
  // the console can distinguish from a probe that failed - hence `unknown`
  // rather than an empty string, and `origin: unknown` rather than `local`.
  it('reports origin "unknown" when nothing stamped the build', () => {
    // Arrange
    const env = { SCRIBEAR_BUILD_VERSION: '   ' };

    // Act
    const info = readBuildInfo(env);

    // Assert
    expect(info).toEqual({
      service: UNKNOWN_BUILD_FIELD,
      version: UNKNOWN_BUILD_FIELD,
      commit: UNKNOWN_BUILD_FIELD,
      ref: UNKNOWN_BUILD_FIELD,
      builtAt: UNKNOWN_BUILD_FIELD,
      imageTags: [],
      pullRequest: null,
      origin: 'unknown',
      dirty: false,
    });
  });

  // build-containers.sh stamps a real commit from the host checkout, so a
  // locally-built image is far more informative than an unstamped one - it just
  // must not be mistaken for something CI published.
  it('reports a local build with its real commit', () => {
    // Arrange
    const env = {
      SCRIBEAR_BUILD_COMMIT: 'def6e68',
      SCRIBEAR_BUILD_REF: 'feat/versions',
      SCRIBEAR_BUILD_ORIGIN: 'local',
    };

    // Act
    const info = readBuildInfo(env);

    // Assert
    expect(info.origin).toBe('local');
    expect(info.commit).toBe('def6e68');
    expect(info.dirty).toBe(false);
  });

  // The `-dirty` suffix rides on the commit rather than in a build arg of its
  // own so `docker inspect`'s revision label carries it too. It is split back
  // out here so the console can flag it without string-matching.
  it('splits a -dirty suffix out of the commit', () => {
    // Arrange
    const env = {
      SCRIBEAR_BUILD_COMMIT: 'def6e68-dirty',
      SCRIBEAR_BUILD_ORIGIN: 'local',
    };

    // Act
    const info = readBuildInfo(env);

    // Assert
    expect(info.commit).toBe('def6e68');
    expect(info.dirty).toBe(true);
  });

  it('reads the pull request a PR build came from', () => {
    // Act
    const info = readBuildInfo({ SCRIBEAR_BUILD_PR: '157' });

    // Assert
    expect(info.pullRequest).toBe(157);
  });

  // Every non-PR build passes this arg empty rather than omitting it, so the
  // empty case is the common one; the rest is refusing to render `NaN`.
  it.each([[''], ['   '], ['abc'], ['0'], ['-3'], ['1.5']])(
    'reports no pull request for %o',
    (raw: string) => {
      // Act
      const info = readBuildInfo({ SCRIBEAR_BUILD_PR: raw });

      // Assert
      expect(info.pullRequest).toBeNull();
    },
  );

  // The build args arrive as one comma-joined string, and CI produces an empty
  // one on a PR build (nothing is published), so the empty and ragged cases are
  // the normal ones rather than defensive padding.
  it('splits, trims and drops empty image tags', () => {
    // Arrange
    const env = { SCRIBEAR_BUILD_TAGS: ' latest , , v1.4.2 ' };

    // Act
    const info = readBuildInfo(env);

    // Assert
    expect(info.imageTags).toEqual(['latest', 'v1.4.2']);
  });

  it('treats an unrecognized origin as unknown', () => {
    // Act
    const info = readBuildInfo({ SCRIBEAR_BUILD_ORIGIN: 'jenkins' });

    // Assert
    expect(info.origin).toBe('unknown');
  });
});
