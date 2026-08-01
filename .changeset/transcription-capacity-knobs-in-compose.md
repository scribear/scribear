---
'@scribear/admin-server': patch
---

The capacity estimator's three tuning knobs are reachable from `.env`, which
they were documented as being and were not.

`transcription_service`'s config has read `TARGET_BUSY`, `MIN_SESSIONS` and
`MAX_SESSIONS` from its environment since they were added, with a comment saying
they are "reachable from `.env` on purpose" and naming the regret they exist to
avoid — a previous set of tuning numbers that lived only as compose-file edits,
which every deployment had to rediscover and hand-set. But none of the three
appeared in `deployment/compose.yml`, `deployment/.env.example` or
`deployment/UPGRADING.md`, so a compose operator's only route to them was
editing the compose file. The same regret, one indirection along.

`compose.yml` now passes all three, `.env.example` documents them, and
`UPGRADING.md` carries the operator note:

- **`TRANSCRIPTION_TARGET_BUSY`** (`0.85`) — the fraction of a worker the
  estimated ceiling aims to keep busy.
- **`TRANSCRIPTION_MIN_SESSIONS`** (`1`) — the floor under that ceiling, so one
  noisy window cannot report a worker's capacity as zero.
- **`TRANSCRIPTION_MAX_SESSIONS`** (empty) — the operator's hard pin. It wins
  over the floor *and* over warm-up, so it applies from the first request rather
  than after a measurement it has already overruled.

All three default to the values already in use, so a stock deployment behaves
identically. The estimate remains observe-only — these change what is
*reported*, not who gets captions.

An empty `MAX_SESSIONS` is now read as "unset". Compose has no way to omit an
environment key, so a stock stack sends the empty string, which `int | None`
refuses to parse — without the coercion the container would fail to boot for
everyone who copied the new file, turning an optional knob into a required one.
The coercion is narrow on purpose: `MAX_SESSIONS=lots` still stops the service,
because auto-tuning silently under a value an operator believed was a hard pin is
a misconfiguration with no symptom to find.

`compose.yml` bumps to **v9**, `EXPECTED_COMPOSE_FILE_VERSION` follows, and the
drift guard's pinned hash is re-pinned.
