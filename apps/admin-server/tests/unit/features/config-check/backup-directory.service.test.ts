import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect } from 'vitest';

import { BackupDirectoryService } from '#src/server/features/config-check/backup-directory.service.js';

describe('BackupDirectoryService', (it) => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backup-directory-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports null when the directory does not exist', async () => {
    const service = new BackupDirectoryService({
      path: join(dir, 'does-not-exist'),
    });

    expect(await service.newestDumpAgeMs()).toBeNull();
  });

  it('reports null when the directory holds no .dump files', async () => {
    await writeFile(join(dir, 'notes.txt'), 'not a dump');
    const service = new BackupDirectoryService({ path: dir });

    expect(await service.newestDumpAgeMs()).toBeNull();
  });

  it('reports the age of a dump that just landed as close to zero', async () => {
    await writeFile(join(dir, 'scribear-db-20260802T040000Z.dump'), 'x');
    const service = new BackupDirectoryService({ path: dir });

    const age = await service.newestDumpAgeMs();

    expect(age).not.toBeNull();
    // Not `>= 0`: the filesystem's mtime clock and `Date.now()` are not
    // guaranteed to agree to sub-millisecond precision, so a dump written
    // moments ago can read as a hair negative. The real invariant is "small",
    // not "non-negative" - staleness is judged in hours, not milliseconds.
    expect(age as number).toBeGreaterThanOrEqual(-1000);
    expect(age as number).toBeLessThan(5000);
  });

  it('reports the newest of several dumps, not the oldest', async () => {
    const now = new Date();
    const anHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const aWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    await writeFile(join(dir, 'old.dump'), 'x');
    await utimes(join(dir, 'old.dump'), aWeekAgo, aWeekAgo);
    await writeFile(join(dir, 'recent.dump'), 'x');
    await utimes(join(dir, 'recent.dump'), anHourAgo, anHourAgo);

    const service = new BackupDirectoryService({ path: dir });
    const age = await service.newestDumpAgeMs();

    // ~1h, not ~1 week - the newest file's age, comfortably inside a margin
    // for however long the test itself takes to run.
    expect(age as number).toBeGreaterThan(59 * 60 * 1000);
    expect(age as number).toBeLessThan(61 * 60 * 1000);
  });

  it('ignores files that are not .dump', async () => {
    await writeFile(join(dir, 'readme.txt'), 'x');
    await writeFile(join(dir, 'scribear-db-20260802T040000Z.dump'), 'x');

    const service = new BackupDirectoryService({ path: dir });

    expect(await service.newestDumpAgeMs()).not.toBeNull();
  });
});
