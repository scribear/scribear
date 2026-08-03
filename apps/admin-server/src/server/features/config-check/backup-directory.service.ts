import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where `db-backup`'s dumps land, read-only bind mount shared with
 * `deployment/compose.yml`'s `db-backup`/`db-restore` services. The only
 * channel Config Check has into that container's health: `db-backup` has no
 * HTTP surface of its own, unlike every other dependency this check reads.
 */
export const BACKUP_DIRECTORY_PATH = '/backups';

export interface BackupDirectoryConfig {
  path: string;
}

/**
 * Reads the age of the newest Postgres dump under the shared bind mount.
 */
export class BackupDirectoryService {
  private _path: string;

  constructor(backupDirectoryConfig: BackupDirectoryConfig) {
    this._path = backupDirectoryConfig.path;
  }

  /**
   * Milliseconds since the newest `*.dump` file was last written, or `null`
   * when the directory cannot be read or holds none yet. Both read the same
   * to a caller: this class has no way to distinguish "db-backup has not run
   * yet" from "the bind mount is missing or empty" — `ConfigCheckService`
   * phrases the resulting finding to cover both.
   */
  async newestDumpAgeMs(): Promise<number | null> {
    let entries: string[];
    try {
      entries = await readdir(this._path);
    } catch {
      return null;
    }

    const dumps = entries.filter((name) => name.endsWith('.dump'));
    if (dumps.length === 0) return null;

    const mtimes = await Promise.all(
      dumps.map(async (name) => {
        try {
          return (await stat(join(this._path, name))).mtimeMs;
        } catch {
          // Removed between the readdir and the stat - db-backup's own
          // retention prune, most likely. Treated as absent rather than
          // failing the whole check over one file.
          return null;
        }
      }),
    );

    const known = mtimes.filter((m): m is number => m !== null);
    if (known.length === 0) return null;

    return Date.now() - Math.max(...known);
  }
}
