---
'@scribear/scribear-db': minor
'@scribear/admin-server': patch
---

Periodic Postgres backups ship with the stack, as a `db-backup` service
reusing the `scribear-db` image rather than a host script and crontab an
operator has to set up and keep in sync on every box separately.

`db-backup` pg_dumps `DB_NAME` on a schedule (default every four hours),
keeps a rolling local retention window, and can optionally push each dump
off the host over scp or rsync-over-ssh. It reaches Postgres over the
`backend` network with the same `DB_HOST`/`DB_USER`/`DB_PASSWORD` every other
service in `deployment/compose.yml` already uses — no `docker exec`, no
Docker socket. It does not use the `pg_cron` extension already loaded into
the same image: `pg_cron` schedules SQL run *by* Postgres, and has no way to
shell out to the external `pg_dump` client that actually produces a dump.

A profile-gated `db-restore` service ships alongside it for restore drills
and the real thing — never started by `up -d`.

`COMPOSE_FILE_VERSION` 9 -> 10, `EXPECTED_COMPOSE_FILE_VERSION` follows, the
drift guard's sha256 is re-pinned, and `deployment/UPGRADING.md` carries the
note.
