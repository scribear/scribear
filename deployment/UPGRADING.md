# Upgrading a deployment

Version-to-version notes for operators running the Docker Compose stack in
[`compose.yml`](compose.yml). Newest first. For first-time setup, start at the
wiki [Deployment](https://github.com/scribear/scribear/wiki/Deployment) page
instead — this file only covers what changes between releases.

The stack reads its configuration from `deployment/.env`. That file is not
tracked, so it does not update when you pull; new required keys have to be added
by hand. [`.env.example`](.env.example) is the tracked reference and always
lists every key the current `compose.yml` understands.

---

## Unreleased — the ASR job period is now per provider (`compose.yml` v2)

**Copy the new [`compose.yml`](compose.yml)** and `docker compose up -d`. Deployment
Check will report `old file` until you do. Nothing breaks if you delay: you lose one
derived series, described below.

### Why it changed

`TRANSCRIPTION_JOB_PERIOD_MS` was a single number (default `1000`) used as the
denominator of the derived **period-utilization** series. It cannot be a single
number. The CUDA templates run `whisper` and `crisper_whisper` at 500ms *alongside*
`lumen_granite` at 3000ms, so one value was wrong for at least two providers at all
times — 2× for whisper, 0.33× for lumen_granite — with no error and no warning. The
only provider it was ever right for was `debug`.

The format is now `provider=ms,provider=ms`:

```
MONITORING_JOB_PERIOD_MS=whisper=500,crisper_whisper=500,lumen_granite=3000   # CUDA templates
MONITORING_JOB_PERIOD_MS=whisper=5000,crisper_whisper=5000,lumen_granite=3000 # CPU templates
```

**It is empty by default, deliberately.** Any shipped default would be wrong for
somebody — CUDA is 500ms, CPU is 5000ms — and quietly misscaling the other group
would be the same bug in a new place. Unset means the sidecar publishes **no**
utilization series for that provider rather than a confidently wrong one. Set it
above to turn the series on; the new `scribear_asr_job_period_ms` gauge (labelled
`source=reported|configured`) shows which denominator is actually in use.

**A bare integer is now rejected** with an error naming the replacement, rather than
applied to every provider. If you had `MONITORING_JOB_PERIOD_MS=1000` in `.env`,
the sidecar will log that error and publish no utilization series until you convert
it to the map form. That is intended: a stale value should be loud rather than
silently averaged across providers it does not fit.

### What is unaffected

RTF and the transcription alerts. `asr_rtf` is measured by transcription-service
itself, and the duty-ratio warning added below is deliberately period-independent —
neither consults this variable. Only the derived period-utilization series does.

---

## Unreleased — transcription-service stops burning CPU it never used

Nothing to change in `.env` or `compose.yml`. Pull the new
`transcription-service-*` image and the CPU drop comes with it.

### What it was doing

A single streaming session on a GPU cost **2.4 cores** of CPU, peaking over
five, on a host whose actual inference was running on the GPU. Almost none of
that was work. Importing `numpy` loads OpenBLAS, which starts one thread per
core (19 on a 20-core host) and *spin-waits* between calls instead of sleeping.
The streaming provider re-transcribes its whole buffer every `job_period_ms`, so
that pool never idled long enough to back off, and 19 threads spun for the life
of every session.

End to end, one session for 90s via `npm run asr:load`, 895 chunks each side:

| | transcripts/1000 chunks | CPU mean | CPU max | cores/session |
| --- | --- | --- | --- | --- |
| before | 174.3 | 238.8% | 513% | 2.39 |
| after | 176.5 | 33.5% | 101% | 0.34 |

Same transcripts, **7× less CPU**. Isolated to one 30s-buffer `transcribe` call
on an RTX 5070 Ti, whisper `turbo`, the waste is starker still — 4.59 cores
against 0.99, with latency slightly *better* (0.75s → 0.68s), the pool having
only added contention. Three concurrent sessions now fit inside a single core.

### If you set `OMP_NUM_THREADS` yourself

The images now set `OMP_NUM_THREADS=1` and `OPENBLAS_NUM_THREADS=1`. An
`environment:` entry in your own `compose.yml` still overrides them, and on the
CPU image raising them is a pessimisation, not a tuning knob: it restores the
spinning pool alongside the inference threads, competing for the same cores.

### CPU inference parallelism moved to `provider_config.json`

The cap above would otherwise have serialised CPU-device inference, which reads
the same variable — 61.8s against 17.97s for a 30s buffer. CTranslate2's thread
count is now set explicitly instead of inherited, and is configurable per
context:

```json
{
  "context_uid": "faster-whisper",
  "context_config": { "model": "turbo", "device": "cpu", "cpu_threads": 8 }
}
```

Unset means 4 on `cpu` (CTranslate2's own default, and parity with the previous
image: 19.33s against 17.97s, minus the 19 spinning threads) and 1 on `cuda`,
where the encoder and decoder are on the GPU and no CPU pool is wanted. Raise it
on a CPU deployment with cores to spare — but count workers first, since
`num_workers` copies of it each claim that many threads.

### Context tags in the templates lost their device suffix

**Nothing to do.** A context `tags` entry is only a match string, resolved
inside the one `provider_config.json` that declares it, so your existing file
keeps working untouched and nothing in the images or the API knows these names.
Called out only because a diff against the templates now shows it.

The CUDA template had been tagging a `"device": "cuda"` context
`whisper_cpu_context`, which reads as a misconfiguration to anyone debugging one
— it cost real time during the CPU investigation above. The device belongs in
`context_config`, which already states it, so the tags no longer repeat it:
`whisper_cpu_context` → `whisper_context`, and
`crisper_whisper_cpu_context` / `crisper_whisper_cuda_context` →
`crisper_whisper_context`. The CPU and CUDA templates now use one tag
vocabulary and differ only where they should, in `context_config`.

---

## Unreleased — the Deployment Check notices an out-of-date `compose.yml`

### A new `compose.yml` row on the Deployment Check page

`deployment/compose.yml` is not part of any image, so `docker compose pull`
never updates it. Until now nothing noticed: a stack could run this month's
images against last month's file, missing whichever services, environment
variables and wiring the new images expect, with every container reporting
green.

`compose.yml` now carries a version number of its own, and admin-server compares
it against the version its image was built for. The result is one more row at
the bottom of **Deployment Check → Deployed versions**, beside the containers:

| Status | What it means | What to do |
| --- | --- | --- |
| `in step` | The file matches these images. | Nothing. |
| `old file` | The images are newer than `compose.yml` — you pulled without copying the file. | Copy the current [`compose.yml`](compose.yml) from the repo over `deployment/compose.yml`, keep your `.env`, and run `docker compose up -d`. |
| `old images` | `compose.yml` is newer than the images — the file was copied but not everything was pulled. | `docker compose pull && docker compose up -d`. |
| `not reported` | The running file predates this check, so it is at least that old. | Same as `old file`: copy the current file and `docker compose up -d`. |

Expect `not reported` on the first upgrade to this release, until the new file is
in place.

**Nothing here can stop a stack from starting.** The version is a plain literal
in `compose.yml` — it changes what the console *reports* and never what runs,
it is not `:?`-guarded, and it is deliberately **not** an `.env` key: an `.env`
carried over from an older release is exactly the thing that goes stale, so
letting it supply this value would let the stale half of a deployment vouch for
the other half. There is nothing to add to `.env` for this, and editing the
literal by hand only makes the console report something untrue.

---

## Unreleased — audio meter and audio telemetry in the admin console

The admin console gains an **Audio meter** nav item and a live **audio health**
strip on each session card. The meter is the same self-contained page the
monitoring sidecar already serves, now reachable from the admin UI at
`/admin/audio-meter.html` through the existing nginx — no new service, no new
port, no nginx change.

### What the audio meter is for

It measures the **local microphone of the device that opens it** — run it on the
room's source machine, not the operator's laptop. An operator at the source
machine clicks the nav item; one who is remote copies the URL and sends it to
whoever is at the room's PC. The page needs a secure context (HTTPS or
`localhost`) for `getUserMedia`, so a deployment running nginx on plain HTTP to
a LAN IP will see the mic button fail — use HTTPS or open it from the machine
itself.

### The nginx image must be upgraded with the rest, or the meter is dead

`/admin/` is served with a Content-Security-Policy, and the meter page keeps its
DSP and UI in inline `<script>` blocks (it is one self-contained file on
purpose, so an audio engineer can copy it to a source machine). The SPA's
`script-src 'self'` blocks those, and it fails **silently**: the page renders in
full, the device list populates, "Start metering" does nothing, and every
readout stays an em-dash. Nothing on screen says why.

`scribear-nginx` therefore ships a policy for that one URL, naming the sha256 of
each script the page contains. **Deploying the new admin-webapp image against an
older nginx gives you the dead page**, and a stale nginx with a *newer* meter
page does the same thing, because the hashes will not match its content. Pull
both images together. To check a running deployment:

```sh
curl -sk https://<host>/admin/audio-meter.html -o /dev/null -D - | grep -i content-security
# script-src must list two sha256-… values; if it says only 'self', nginx is stale
```

The check that catches this before a release is a browser, not a request: a
`200` response and correct bytes prove nothing here, because the page that runs
and the page that is inert are byte-identical.

### Clipping is now measured as runs at the rail (behaviour change)

`clippingPct` on published audio telemetry changed meaning. It used to count
**any** sample within 1e-4 of full scale; it now counts samples at or above
**0.99** of full scale that belong to a run of at least **two consecutive**
samples — the same rule the standalone meter page has always used.

The old definition charged undistorted audio as clipping. A clean tone at full
scale reaches 1.0 at one isolated sample per crest, which at 16 kHz worked out to
12.5 % of samples — past the 1 % threshold for a red **clipping** chip. So:

- Sessions that showed a red `clipping` chip while sounding fine, and whose audio
  simply ran hot to full scale, will now read normally. If a room's chip
  disappears after this upgrade, that is this change, not a metering regression.
- Genuinely clipped audio is unaffected: a hard-limited source has flat runs at
  the rail and still reads far above the threshold (a sine driven 3.5 dB into a
  limiter reads ~62 %, identically on both surfaces).
- No dashboard, alert, or env-var change is needed. No other field moved, and
  nothing outside the dashboard's display and status derivation reads this field.

The two implementations are now held to one expectation table in
`tools/audio-meter-crosscheck/`, so this class of disagreement fails CI rather
than reaching an operator.

### Audio telemetry is now measured at several points in the pipeline

Previously the audio reading was taken inside the Whisper provider's worker. Two
consequences, both fixed here:

**Deployments not running Whisper had no audio telemetry at all, and the
dashboard reported that absence as a microphone fault.** Of the four providers
in `provider_config.template.json`, only `whisper` and `crisper_whisper` run
whisper-streaming. On a `lumen_granite` or `debug` deployment nothing published
an audio snapshot, and the dashboard maps "no snapshot on a live session" to a
red **no audio reaching ASR** chip. So *every healthy session showed a red audio
chip beside a green connectivity chip.* If your deployment runs `lumen_granite`
or `debug`, those false red chips disappear after this upgrade and you get real
audio health for the first time.

**Audio is now measured where it arrives**, before any provider sees it, plus at
each point downstream that can report. A session's snapshot carries a list of
stages:

| Stage | Where it is measured | What a problem here means |
| --- | --- | --- |
| `ingress` | audio arriving at Transcription Service, every provider | the source is not sending good audio — mic muted, unplugged, wrong input |
| `asr_input` | after the worker decoded it into the ASR's buffer | the pipeline is losing audio — dropped chunks, decode failures, a client sending faster than the window holds |
| `vad` | the speech the detector passed on (Whisper only) | voice-activity detection is gating too aggressively |

Each stage reports cumulative seconds of audio that passed it, so the console can
show **where** audio was lost rather than only that something is wrong. The
session detail page gains a table of these stages.

> ⚠️ **A green audio chip now asserts less than it used to.** It means the source
> is sending good audio. It no longer implies the ASR is producing, because the
> reading is no longer taken from a transcription result — a stalled model or an
> unreachable upstream now shows on the **connectivity** chip and as a gap
> between `ingress` and `asr_input`, not as an audio fault. This is deliberate:
> audio quality and pipeline liveness are two different questions and a single
> chip answering both answered neither reliably.

Operators who had learned "red audio chip = check the microphone" can keep that
reading — it is now more accurate, not less.

### One new env var, optional

`TRANSCRIPTION_AUDIO_SILENCE_THRESHOLD` sets the linear RMS level at or below
which a metering window reads as digital silence. It **defaults to `0.01`**,
which is the value the Whisper provider already used, so leaving it unset
preserves current behaviour exactly and no deployment has to add it. Raise it
only if rooms with a genuinely quiet but working mic are being flagged silent.

Otherwise the audio panel still rides `TRANSCRIPTION_REDIS_URL`, the same switch
the fleet view already uses. If the fleet view works in an environment, audio
telemetry is being published there too. The `audio-meter.html` page itself needs
no backend at all.

### The published payload shape changed

The value at `scribe:v1:audio:{sessionUid}` moved from flat level fields plus a
top-level `vadStats` to the `stages` list described above. Both the publisher and
the reader ship from this repo, and the key expires after 10 seconds, so a
rolling upgrade costs at most one dashboard refresh of missing audio telemetry —
there is nothing to migrate and no ordering requirement between services. If you
have anything of your own reading that key directly, it needs updating.

### Fleet telemetry now discards a snapshot it cannot parse (behaviour change)

`/fleet` validates every snapshot it reads from the backplane against the schema
it was published under, and **drops** any that does not match, rather than
serving it through unchecked. That applies to all four indexes: Node Server
instances, sessions, Transcription Service hosts and session audio.

For a healthy deployment this changes nothing — every publisher in the stack
ships from this repo, and each one is now pinned against the reader's schema by
a test that runs the real publisher and parses its actual bytes.

It matters in one situation: **a mixed-version fleet during a rolling upgrade**,
where an older instance may publish a shape this version no longer recognises.
Such an instance disappears from the fleet view until it is upgraded, instead of
appearing with blank or wrong fields. That is deliberate — a card populated from
an unvalidated payload is worse than an absent one, because nothing on screen
says which fields are trustworthy — but it means a fleet view that looks short
of instances mid-upgrade is reporting a real version skew rather than an outage.

Dropped snapshots are logged by `admin-server` at `warn`, one line per index per
minute, naming the index, a sample of the affected members and what specifically
failed to match:

```
dropped fleet telemetry snapshots that failed to parse
  indexKey=scribe:v1:transcription-hosts:index droppedCount=3
  droppedSample=[{ member: "ts-a", reason: "schema-mismatch",
                   errors: ["/workers/0/contextIds/0: must be integer"] }]
```

A steady stream of those lines after an upgrade has finished is a genuine
publisher/reader mismatch and worth reporting; during a rolling upgrade it is
expected and stops on its own.

### Where the page moved

The standalone meter page moved from `apps/monitoring-sidecar/public/` to the
shared `libs/audio-meter-page/` directory so both the sidecar and admin-webapp
serve the same file. The sidecar's `/api/monitoring/v1/audio-meter` route keeps
working unchanged for in-cluster/port-forward use; `AUDIO_METER_PATH`'s default
updated to match the new location, so an override is only needed if a deployment
had set it explicitly.

---

## Unreleased — every container reports what it was built from

The admin console's **Deployment Check** page gained a **Deployed versions**
table: one row per container, showing the version, commit, branch, build time
and image tags it was built from. Nothing to add to `.env` — the six new
admin-server variables all default to their compose service names.

### Why it exists

Every service knows its own build and no service knows anyone else's, so an
upgrade that pulled some images and not others has been invisible from inside
the stack. The health rollup cannot see it either: a container running last
month's image is a perfectly healthy container, and it stays green.

The table takes the commit the most containers report as the deployment's, and
names any container that disagrees. That is the case worth watching for — it is
what a `docker compose up -d` that half-failed, or a service pinned to a
different `IMAGE_TAG`, looks like from the outside.

### What the statuses mean

| Status | What happened |
| --- | --- |
| `reporting` | Answered with its build. |
| `old image` | Answered, and has no build document — the image predates this release, so it was **not** recreated by your last upgrade. |
| `no answer` | Could not be reached at all. The container is down, not stale. |
| `n/a` | `scribear-db` and `redis` have no HTTP surface to report a build on. Their versions still move with `IMAGE_TAG`; read them with `docker compose images`. |

The first upgrade to this release is the one time `old image` is expected: it
appears for anything that has not been recreated yet. Run `docker compose up -d`
in `deployment/` and re-check — every row should turn to `reporting`.

### Locally built images

`build-containers.sh` now stamps the commit it built from, marks the image as a
local build, and appends `-dirty` when the working tree had uncommitted
changes. A stack started straight from a checkout (`npm run dev`) has no image
to stamp and says so, rather than showing a table of blanks.

### Reading it without the console

Every value is also an image label, so a shell on the host answers the same
question:

```
docker compose images
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  ghcr.io/scribear/admin-server:latest
```

### Note for anyone building images by hand

`scribear-nginx` now builds from the repository root rather than from
`infra/scribear-nginx`, because it shares the webapps' build-info generator:

```
docker build -f infra/scribear-nginx/Dockerfile .
```

`build-containers.sh` and CI already do this; only a hand-rolled `docker build`
needs changing.

---

## 0.3.0 — migrations run themselves

Every deploy now applies the database schema as part of `docker compose up
-d`, instead of relying on someone remembering to run a separate script
afterwards. Nothing new to add to `.env` — if you already run `docker compose
up -d` for every upgrade, you get the new behaviour for free.

### What was wrong before

`run-migrator.sh` used to `docker run` a throwaway `node:24-alpine`
container, `git clone` `https://github.com/scribear/scribear.git`, check out
`staging`, `npm ci`, and run the migrator from that checkout — and it exited
0 the moment the database had *any* table at all:

```
Tables detected! Database is already configured. Exiting setup...
```

That check was meant to skip a virgin database that did not need
initialising, but it also skipped every database that already had a schema —
which is every database after the first deploy. In practice the script only
ever did anything once, on day one; every later release's migrations were
silently never applied unless someone ran them by hand. It also always
applied whatever `staging` held at that moment regardless of the `IMAGE_TAG`
a deployment was actually pinned to, and it needed the bundled `scribear-db`
container on the `backend` network, so it could not target an external
Postgres, and it was the wrong tool for a locally built image since it
applied the published schema instead of the working tree.

### What runs now

`compose.yml` gained a `db-migrate` service: the same image and `IMAGE_TAG`
as `session-manager`, running a second entry point (`dist/migrate.mjs`) that
applies whatever migrations are pending and exits. `session-manager` and
`admin-server` both `depends_on: db-migrate: {condition:
service_completed_successfully}`, so `docker compose up -d` migrates the
schema before either service starts, and a failed migration means neither
starts — the reason is in `docker compose logs db-migrate`, not scattered
across two crash loops. It is idempotent: `docker compose up -d` re-runs it
every time and it exits in about a second when nothing is pending.

The migrations themselves are unchanged and the migration table is still
`kysely_migration`, so an existing database needs no special handling — the
job just picks up wherever it left off.

`run-migrator.sh` is now a thin wrapper around the same job —
`docker compose run --rm db-migrate` — for applying migrations on their own
without starting the rest of the stack, or to see the migration output by
itself. Nothing is cloned or installed at run time any more; it applies
whatever the pinned `IMAGE_TAG` ships, which also means it now works against
an external Postgres, since the job reads only the `DB_*` variables (see
_Running Postgres or Redis outside the stack_ below, updated for this).

### Readiness and the admin console now know when the schema is stale

`GET /api/session-manager/v1/probes/readiness` reports the database and the
schema as separate checks and returns 503 if either fails:

```json
{ "status": "fail", "checks": { "database": "ok", "schema": "fail" } }
```

`schema: "fail"` means this build ships migrations the database has not
applied yet. A database *ahead* of the build — what a rollback looks like —
is deliberately not treated as a failure; the service just runs with more
schema than it uses. Once the schema catches up the service goes ready on its
own, with no restart needed.

A new admin-key-protected route, `GET
/api/session-manager/v1/database/schema`, reports the full picture:
`{ initialized, applied, expected, pending, unknown, upToDate, latestApplied,
latestExpected }`. The admin console's **Config Check** uses it to raise:

- `schema-never-migrated` — the migration table does not exist yet.
- `schema-migrations-pending` — the database is behind this build.
- `schema-ahead-of-containers` — the database is ahead of this build (a
  rollback, most likely).
- `schema-version-skew` — session-manager and admin-server were built
  against different schema versions, which means they are running mixed
  `IMAGE_TAG`s.
- `schema-version-unreadable` — the database answered but the migration
  table could not be read, usually a permissions problem.

### Rollback

Reverting `compose.yml` to the previous release drops `db-migrate` and the
`depends_on` entries pointing at it; nothing here rewrites data or removes a
migration, so the schema is simply left where it is.

## 0.2.0 — monitoring & fleet dashboard

Adds the admin fleet dashboard, the monitoring sidecar, a Redis telemetry
backplane, and the admin console's Config Check page.

Every image moves from `0.1.0` to `0.2.0` together — the npm packages are a
changesets `fixed` group, and `transcription_service/pyproject.toml` is kept in
step by hand. Two changes in this release are breaking (see _Breaking changes_
below); they are a minor bump rather than a major one because the project is
pre-1.0, where `1.0.0` is reserved for declaring the API stable.

### Optional: tell the Config Check what this deployment is

New in this release: **Admin → Config Check** reports the deployment's
configuration posture — placeholder secrets, missing login methods, a telemetry
backplane that nothing publishes to, containers that never came up.

Severity depends on what the deployment _is_: a placeholder password is
unremarkable on a laptop and a compromise in production. Set `DEPLOYMENT_ENV` so
the page judges against the right standard.

```dotenv
# development | staging | production
DEPLOYMENT_ENV=production
```

Leaving it unset infers `production` unless admin-server was started with
`--dev`. That is the deliberate direction: an existing deployment that never
sets it is judged strictly rather than reassured. The variable is reporting-only
— nothing behaves differently — and an unrecognized value is reported by the
check itself rather than blocking startup.

Every finding also carries the severity it _would_ have in production, so a
staging deployment can be checked for promotion-readiness without changing
anything. The page never displays a secret value, only whether each is set and
how long it is.

### What breaks if you upgrade without reading this

`docker compose up` **fails immediately**, before any container starts, with:

```
error while interpolating services.node-server.environment.NODE_SERVER_SERVICE_API_KEY:
required variable NODE_SERVER_SERVICE_KEY is missing a value: NODE_SERVER_SERVICE_KEY is
unset. Your .env predates the monitoring/fleet release - read deployment/UPGRADING.md
(or the wiki Deployment page) and add the new keys before starting.
```

That is deliberate. Both new secrets fail _open_ rather than closed if left
blank, so the compose file refuses to interpolate them rather than let the
stack come up in that state:

- An empty `NODE_SERVER_SERVICE_KEY` makes the node server's internal service
  routes accept any caller that sends a bare `Authorization: Bearer ` header —
  the empty configured key matches the empty presented key.
- An empty `REDIS_PASSWORD` does not produce a locked-down Redis. `redis-server
--requirepass ""` is an _open_ server that accepts every unauthenticated
  command, and it would be holding the whole fleet's operational state.

The services enforce the same rule independently of Compose: node-server,
session-manager and transcription-service now refuse to boot on an empty or
`CHANGEME` key, so Kubernetes or hand-rolled `docker run` deployments fail
loudly too. The placeholder test matches `CHANGEME` as a substring, so the
example values that carry a length-rule suffix —
`CHANGEME-JWT-must-be-at-least-32-characters-long` and friends — are caught as
well. **If any secret in your `.env` still contains `CHANGEME`, that service
will now refuse to start.** That is the intended behaviour, but it will surface
on upgrade rather than at leisure, so check before you pull.

### Required `.env` additions

Two new keys, both mandatory. Everything else this release adds is optional and
defaulted — see _Complete `.env` delta_ below for the full picture. Generate a
distinct high-entropy value for each — for example `openssl rand -hex 32`.

```dotenv
# Inbound service-to-service auth for the node server's internal observability
# routes (read by the monitoring sidecar). MUST be a different secret from
# NODE_SERVER_KEY, which the node server presents outbound to session-manager.
NODE_SERVER_SERVICE_KEY=<new secret>

# Password for the Redis telemetry backplane.
REDIS_PASSWORD=<new secret>
```

### New containers

Two services join the stack. Both are pulled from the same registry and tag as
everything else, and CI publishes them alongside the existing images, so no
registry or tag changes are needed.

| Service              | Image                | Notes                                                                                                                                                             |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis`              | `scribear-redis`     | Telemetry backplane. Not published to the host; `backend` network only. No persistence — every key is a short-TTL snapshot its publisher rewrites within seconds. |
| `monitoring-sidecar` | `monitoring-sidecar` | Black-box poller. No longer mounts the Docker socket — the log-ingestion path it needed that for was removed in B1.2.                                             |

Nothing in the transcription path reads or writes Redis. Losing it costs the
dashboard its cross-instance view and costs live sessions nothing.

Plan for the extra resident memory of two more containers on the host. If you
pin images by digest rather than tag, add entries for both.

### Optional: turning telemetry on

Standing up Redis does **not** switch telemetry on. Every publisher and reader
is gated on its own `*_REDIS_URL`, all unset by default, so after the upgrade
the container runs and nothing talks to it. This is intentional: introducing
shared infrastructure in the same step that starts depending on it makes a
telemetry bug and a deployment bug look identical.

To populate the fleet view, set these to the same Redis using the password
above, then restart the affected services:

```dotenv
NODE_SERVER_REDIS_URL=redis://:<REDIS_PASSWORD>@redis:6379
TRANSCRIPTION_REDIS_URL=redis://:<REDIS_PASSWORD>@redis:6379
ADMIN_REDIS_URL=redis://:<REDIS_PASSWORD>@redis:6379
```

Leaving them unset is a supported steady state. With `ADMIN_REDIS_URL` unset,
`GET /api/admin/v1/fleet` answers `503 TELEMETRY_UNAVAILABLE`; the admin
console's top-bar health rollup is a separate, always-on data path and is
unaffected either way.

### Optional: monitoring sidecar metrics

The sidecar polls two authenticated endpoints. Each is independently disabled
when its key is blank, and a blank key is a _silent_ degradation — the sidecar
runs, the affected metric series are simply empty. The log parsers that used to
infer these signals were retired when the endpoints landed, so there is no
fallback source.

```dotenv
# Read-only key for transcription-service's /metrics/status. Deliberately NOT
# TRANSCRIPTION_API_KEY: that one opens transcription sessions, this one only
# reads counters. Set it on BOTH sides or the poll 404s.
TRANSCRIPTION_METRICS_KEY=<new secret>
```

`NODE_SERVER_SERVICE_KEY` above already covers the node-server status poll.

The synthetic canary (`MONITORING_CANARY_DEVICE_TOKEN`) is off by default and
needs a one-time device registration. **It streams synthetic speech into a real
session**, so its device must belong to a dedicated canary room — pointing it at
a teaching room injects fixture audio into that lecture's live captions. Setup
steps are in [`../apps/monitoring-sidecar/.env.example`](../apps/monitoring-sidecar/.env.example).

### Breaking changes to existing behaviour

- **Docker log ingestion is gone.** Anything scraping the monitoring sidecar's
  log-derived metrics needs to move to the polled endpoints above.
- **The admin health rollup now covers every service**, so its response shape
  changed. Re-check any external consumer of `/api/admin/v1/health`.

### Optional: automatic image updates (watchtower)

`watchtower` polls the registry and recreates any container whose tag now points
at a newer digest. It is in `compose.yml` behind the `autoupdate` profile, so it
does **not** start unless you ask for it:

```dotenv
COMPOSE_PROFILES=autoupdate
WATCHTOWER_POLL_INTERVAL=1800
```

Then `docker compose up -d` as usual — no `-f` flags.

On staging, where `IMAGE_TAG=staging` and every push republishes it, this is
what makes the box continuously deployed with nobody logging in. **Think before
production.** Recreating a container ends every WebSocket it was serving, so an
update to `node-server` or `transcription-service` drops the sessions they are
carrying — captions stop mid-sentence and the kiosk has to reconnect. It is also
unattended: with `IMAGE_TAG=latest`, a merge to `main` deploys itself, at
whatever hour it happens to land. Production generally wants a chosen moment.

It also mounts the Docker socket, which is root-equivalent on the host. The
monitoring sidecar gave up exactly that mount in B1.2; enabling this profile
puts one back, in a container whose job is to pull images and restart things.

`WATCHTOWER_SCOPE` is empty by default, which means watchtower updates **every
container on the host**, including any unrelated to ScribeAR. On a dedicated box
that is usually what you want. To narrow it, set a name and label the containers
to include:

```dotenv
WATCHTOWER_SCOPE=scribear
```

```yaml
# compose.override.yml — repeat per service you want auto-updated
services:
  node-server:
    labels:
      com.centurylinklabs.watchtower.scope: scribear
```

`WATCHTOWER_CLEANUP` is on unconditionally: without it the superseded image
layers are never reclaimed and a box polling every 30 minutes fills its disk.

### Postgres is no longer published on every interface

`scribear-db` published `5432:5432`, which binds **every interface the host
has** — on a public box that is Postgres exposed to the internet behind nothing
but `DB_PASSWORD`. It is now `127.0.0.1:5432:5432`.

Nothing in the stack is affected: services reach Postgres over the `backend`
network by hostname, and `run-migrator.sh` runs inside a container on that same
network. Only `psql` from the host itself still works — which is what the
publish was for. If you were connecting from another machine, that now needs a
deliberate choice (see below), and it is worth checking your access logs for who
else was.

> A host firewall is **not** a substitute here. Docker's DNAT rules are
> traversed before ufw's `INPUT` chain, so `ufw deny 5432` appears to apply and
> leaves the port reachable. Filtering a published Docker port means a
> `DOCKER-USER` rule. Binding the interface avoids the question.

### Running Postgres or Redis outside the stack

Production may want a managed or separately-administered database and cache
rather than the bundled containers. Both are supported; the split is that
**`.env` says where they are** and **`compose.override.yml` removes the bundled
services**.

#### Redis (easier — nothing depends on it)

Every consumer already takes a full URL, so pointing them elsewhere is `.env`
only:

```dotenv
REDIS_PASSWORD=<the external server's password>
ADMIN_REDIS_URL=redis://:<password>@redis.example.edu:6379
NODE_SERVER_REDIS_URL=redis://:<password>@redis.example.edu:6379
TRANSCRIPTION_REDIS_URL=redis://:<password>@redis.example.edu:6379
```

Then stop running the bundled one — `deployment/compose.override.yml`:

```yaml
services:
  redis: !reset null
```

> **Keep `REDIS_PASSWORD` set even though the container is gone.** Compose
> interpolates the base file _before_ merging the override, so the `${VAR:?}`
> guard on the removed service still fires and `docker compose up` aborts
> without it. Setting it to the external server's password — the same value used
> in the URLs above — keeps it honest rather than a dummy.

Use `rediss://` if the external server expects TLS.

#### Postgres

`DB_HOST` and `DB_PORT` are now read from `.env` (defaulting to the bundled
container), so the connection itself is configuration:

```dotenv
DB_HOST=pg.example.edu
DB_PORT=5432
DB_NAME=scribear
DB_USER=scribear
DB_PASSWORD=<managed instance password>
```

Removing the bundled service needs one more step than Redis, because
`session-manager`, `admin-server` and `db-migrate` itself all `depends_on`
it. Compose rejects a `depends_on` pointing at a service that no longer
exists —

```
service "admin-server" depends on undefined service "scribear-db": invalid compose project
```

— so the override has to replace those too. Keep `db-migrate` running — it is
what applies the schema to the external instance — and only drop each
service's dependency on the bundled container:

```yaml
services:
  scribear-db: !reset null

  db-migrate:
    depends_on: !override {}

  session-manager:
    depends_on: !override
      db-migrate:
        condition: service_completed_successfully

  admin-server:
    # Keep the session-manager and db-migrate dependencies; only drop the
    # database one.
    depends_on: !override
      session-manager:
        condition: service_healthy
      db-migrate:
        condition: service_completed_successfully
```

`!reset` and `!override` need Compose v2.24+ (`docker compose version`).

Verify the merged result before starting anything:

```
docker compose config | grep -E 'DB_HOST|REDIS_URL'
docker compose config --services      # scribear-db and redis should be absent
```

**Migrations.** `run-migrator.sh` now runs the `db-migrate` job
(`docker compose run --rm db-migrate`), which reads only the `DB_*` variables
above, so it already works against the external instance — no adaptation
needed. Just remember `db-migrate` is one of the services whose own
`depends_on: scribear-db` has to be dropped in the override above; keep the
job itself, only its dependency on the bundled container goes.

**Networking.** The services must be able to reach the external hosts from
inside their containers, which is a different question from whether the _host_
can. Check firewall rules and any egress restriction on the Docker networks.
`scribear-db`'s healthcheck no longer gates startup once the service is removed,
so a wrong `DB_HOST` surfaces as a service that starts and then fails its own
readiness rather than as a container that never starts.

### New optional tuning knobs

All defaulted; the stack behaves identically if you ignore them. See
[`.env.example`](.env.example) for the full annotated list — device presence
(`DEVICE_ONLINE_TTL_SEC`, `DEVICE_LAST_SEEN_WRITE_SEC`), the health-rollup
timeout (`ADMIN_HEALTH_TIMEOUT_SEC`), and the sidecar's poll intervals and alert
thresholds (`MONITORING_*`).

### Complete `.env` delta

Everything `compose.yml` reads that a pre-0.2.0 `.env` does not have. Only the
first two are required; the rest have working defaults and can be added when you
want the feature.

| Key                                                   | Needed?      | What it is for                                                                           |
| ----------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `NODE_SERVER_SERVICE_KEY`                             | **Required** | Inbound service auth on node-server. Stack will not start without it.                    |
| `REDIS_PASSWORD`                                      | **Required** | Telemetry backplane password. Stack will not start without it.                           |
| `DEPLOYMENT_ENV`                                      | Recommended  | Which standard the Config Check judges against. Unset infers `production`.               |
| `ADMIN_REDIS_URL`                                     | Optional     | Lets the admin console read the fleet view. Unset ⇒ `/fleet` answers 503.                |
| `NODE_SERVER_REDIS_URL`                               | Optional     | Lets node-server publish telemetry. Unset ⇒ absent from the dashboard.                   |
| `TRANSCRIPTION_REDIS_URL`                             | Optional     | Same, for transcription-service.                                                         |
| `TRANSCRIPTION_METRICS_KEY`                           | Optional     | Read-only key for `/metrics/status`. Unset ⇒ sidecar's transcription metrics stay empty. |
| `COMPOSE_PROFILES`                                    | Optional     | `autoupdate` switches on watchtower.                                                     |
| `WATCHTOWER_POLL_INTERVAL`, `WATCHTOWER_SCOPE`        | Optional     | Only read when that profile is on.                                                       |
| `ADMIN_HEALTH_TIMEOUT_SEC`                            | Optional     | Per-component timeout for the health rollup (default 3).                                 |
| `DEVICE_ONLINE_TTL_SEC`, `DEVICE_LAST_SEEN_WRITE_SEC` | Optional     | Device presence tuning (defaults 180 / 60).                                              |
| `MONITORING_*`                                        | Optional     | Sidecar poll intervals, alert thresholds, canary. All defaulted.                         |

Nothing was removed: every key a 0.1.x `.env` already had is still read. `ORIGIN`
is not referenced by `compose.yml` and never was — it is read by the helper
scripts in this directory (`create-room.sh`, `register-device.sh`,
`create-session.sh`), so keep it.

### Moving a host off a hand-edited `compose.yml`

If a deployment forked `compose.yml` to add something locally, it will not pick
up any of the above by pulling. Move it back onto the tracked file:

1. `diff` your host's `compose.yml` against the tracked one for the release you
   forked from — `git show <tag>:deployment/compose.yml` — so you know exactly
   what is local. It is usually less than it feels like.
2. Anything that is now upstream (watchtower is, as of this release) needs no
   action beyond the `.env` keys above.
3. Put whatever genuinely remains in `deployment/compose.override.yml`. Compose
   loads that automatically next to `compose.yml`, with no `-f` flags, and it is
   gitignored. Only the keys you restate are overridden.
4. Replace the host's `compose.yml` with the tracked one and `docker compose
config` to confirm the merged result before `up -d`.

The point is that the host stops carrying a fork that silently misses every
later change — which is how a deployment ends up several releases behind on
exactly the settings it most needs.

### `TRANSCRIPTION_DEVICE` gained a value

`cuda128` (CUDA 12.8 / cuDNN 9) joins `cpu` and `cuda` (CUDA 12.2 / cuDNN 8).
Blackwell (sm_120) and newer GPUs need `cuda128`. Existing `cpu` and `cuda`
values are unchanged.

### Rollback

Reverting `compose.yml` to the previous release is sufficient; the two new keys
are ignored by it. Nothing in this release migrates the database or rewrites
persistent state, and Redis holds nothing worth preserving.
