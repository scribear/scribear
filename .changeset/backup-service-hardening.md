---
'@scribear/scribear-db': patch
'@scribear/admin-server': minor
---

Hardens the Postgres backup service (`db-backup`) from a code review after it
shipped:

- Failed off-host pushes (scp/rsync) now retry every cycle until they
  succeed, instead of silently leaving a permanent gap in the offsite backup
  chain when the destination was unreachable for more than one cycle.
- Every dump is checked with `pg_restore -l` immediately after `pg_dump`
  exits 0 and discarded if it fails — `pg_dump` can exit 0 on an archive
  nothing can actually read back.
- `pg_dumpall --globals-only` now runs alongside the main dump, covering
  roles that `pg_dump` alone never backed up.
- New `BACKUP_ENABLED` (default `true`): set to `false` for a deployment on
  managed Postgres with its own backups — `db-backup` idles instead of
  dumping, and Deployment Check reports the choice explicitly (`backup-disabled`)
  instead of `backup-none-found` forever.
- New `BACKUP_ENCRYPTION_KEY` (empty/off by default): optional GPG AES256
  symmetric encryption for every dump, at rest and offsite. `db-restore`
  decrypts automatically when given a `.gpg` file and the same key.
- `db-backup`'s healthcheck `start_period` is 30 minutes now, not 2 — long
  enough for a large database's first `pg_dump` to finish before being read
  as a failed container.
- `BACKUP_INTERVAL_SECONDS`/`BACKUP_RETENTION_DAYS` are validated as positive
  integers on startup rather than failing confusingly (a busy-loop on `0`, a
  crash-loop on anything non-numeric).
- Corrected a misleading comment claiming `pg_restore --clean --if-exists`
  "overwrites" the target database — it drops and recreates only what the
  dump itself contains.

`COMPOSE_FILE_VERSION` 11 -> 12, `EXPECTED_COMPOSE_FILE_VERSION` follows, the
drift guard's sha256 is re-pinned, and `deployment/UPGRADING.md` carries the
note — including the RPO/WAL-archiving tradeoff and the offsite host's
trust-on-first-connection behavior, both previously undocumented.
