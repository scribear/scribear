# Tests To Create — Coverage ❌ Triage (PR #120)

## TL;DR

The red **❌** in those tables is a **code-coverage health rating** (line-rate `< ~50%`), **not a
failed test**. A ❌ only means "few/no tests executed this package."

Crucially, coverage is reported **separately for `unit` and `integration` test runs**. Almost every
❌ in a *unit* report is a package that is fully exercised by the *integration* suite (and vice
versa). Once you cross-reference the two reports, only a small number of ❌ represent code that **no
test touches at all**.

**Bottom line:**
- **Add 2 tests** — `app-config.ts` in `session-manager` and `node-server` (0% in *both* suites, and
  the code is designed to be unit-testable).
- **Suppress/exclude 3 entrypoints** — `index.ts` bootstrap files (session-manager, node-server, and
  base-fastify-server's `server` bootstrap). Not meaningfully unit-testable.
- **No action for the rest** — they are false alarms; the other test suite already covers them.

---

## Decision Matrix

Legend: **ADD** = write a test · **SUPPRESS** = exclude from coverage (bootstrap glue) · **NONE** =
false alarm, covered by the other suite.

### Session Manager

| Package (unit ❌) | Unit | Integration | Decision | Why |
|---|---|---|---|---|
| `src` (`index.ts`) | 0% | 0% ❌ | **SUPPRESS** | Bootstrap entrypoint: `main()` + `fastify.listen`. Not unit-testable without full mock harness. |
| `src.app-config` | 0% | 0% ❌ | **ADD** | Env-schema validation + getter mapping + `--dev` flag. Untested by anything. Ctor takes a `path` arg *specifically* for testing. |
| `src.db` | 0% | 83% ✔ | NONE | Covered by integration (`device-management.repository.test.ts`, etc.). |
| `src.server` (`create-server.ts`) | 0% | 100% ✔ | NONE | Covered by every integration route test. |
| `src.server.dependency-injection` | 0% | 88% ✔ | NONE | Covered by integration wiring. |
| `src.server.features.probes` | 0% | 100% ✔ | NONE | Covered by `integration/features/probes/probes.routes.test.ts`. |
| `src.server.features.schedule-management` | 33% | 88% ✔ | NONE | Service/router/repository are exercised by `integration/.../schedule-management.*.test.ts`. Unit run only sees the controller. |
| `src.server.plugins` (`swagger.ts`) | 0% | 100% ✔ | NONE | Covered by `integration/swagger.test.ts`. |
| `src.server.shared.repositories` | 0% | 100% ✔ | NONE | Covered by `integration/shared/repositories/device-auth.repository.test.ts`. |

### Node Server

| Package (unit ❌) | Unit | Integration | Decision | Why |
|---|---|---|---|---|
| `src` (`index.ts`) | 0% | 0% ❌ | **SUPPRESS** | Bootstrap entrypoint (identical shape to session-manager). |
| `src.app-config` | 0% | 0% ❌ | **ADD** | Same reasoning as session-manager: real, untested config logic. |
| `src.server` | 0% | 100% ✔ | NONE | Covered by integration. |
| `src.server.dependency-injection` | 0% | 89% ✔ | NONE | Covered by integration. |
| `src.server.features.probes` | 0% | 100% ✔ | NONE | Covered by `integration/features/probes/probes.routes.test.ts`. |
| `src.server.plugins` | 0% | 100% ✔ | NONE | Covered by `integration/swagger.test.ts`. |

### Base Fastify Server

| Package (unit ❌) | Unit | Decision | Why |
|---|---|---|---|
| `server` | 0% | **SUPPRESS** | This bucket is the bootstrap trio: `index.ts` (barrel export), `create-base-server.ts`, `create-logger.ts`. `create-base-server` is exercised by the lib's own integration tests (`dependency-injection.test.ts`, `error-handling.test.ts`, `request-*.test.ts`); the plugins/hooks/errors underneath it are unit-tested and green. The remaining lines are wiring/logger factory. |

### Transcription Service

| Package | Unit | Integration | Decision | Why |
|---|---|---|---|---|
| `src.webserver.features.probes` | 33% ❌ | 100% ✔ | NONE | Router covered by `integration/probes/probes_test.py`. |
| `src.shared.logger.formatters` | 91% ✔ | 34% ❌ | NONE | Fully covered by the **unit** suite; the integration ❌ is the mirror-image false alarm. |

---

## Work Items (ADD)

### 1. `apps/session-manager/tests/unit/app-config/app-config.test.ts`

Target: `apps/session-manager/src/app-config/app-config.ts` (currently 0% everywhere).

The constructor accepts an optional dotenv `path`, so tests can point it at a fixture `.env` file
(or set `process.env` directly before construction). Suggested cases:

- **Loads and maps a fully-populated env** — construct `AppConfig` with all required vars set, then
  assert each getter returns the correctly-mapped object:
  - `baseConfig` → `{ isDevelopment, logLevel, port, host }`
  - `adminAuthConfig.adminApiKey` ← `ADMIN_API_KEY`
  - `serviceAuthConfig.serviceApiKey` ← `SESSION_MANAGER_SERVICE_API_KEY`
  - `sessionTokenConfig.signingKey` ← `SESSION_TOKEN_SIGNING_KEY`
  - `dbClientConfig` ← the five `DB_*` vars (with `DB_PORT`/`PORT` coerced to `number`)
  - `materializationWorkerConfig` → `DEFAULT_MATERIALIZATION_WORKER_CONFIG`
- **`--dev` flag** — with `process.argv` containing `--dev`, `baseConfig.isDevelopment === true`;
  without it, `false`. (Save/restore `process.argv` in `beforeEach`/`afterEach`.)
- **Schema validation rejects bad input** — missing a required var, or `PORT` out of the
  `0..65535` range / non-integer, throws.

Notes: isolate `process.env` per test (snapshot & restore) so cases don't leak into each other.

### 2. `apps/node-server/tests/unit/app-config/app-config.test.ts`

Target: `apps/node-server/src/app-config/app-config.ts` (currently 0% everywhere).

Same structure as above, against node-server's schema. Assert getters map:

- `baseConfig` → `{ isDevelopment, logLevel, port, host }`
- `sessionManagerClientConfig` ← `SESSION_MANAGER_BASE_URL`, `SESSION_MANAGER_SERVICE_API_KEY`
- `transcriptionServiceClientConfig` ← `TRANSCRIPTION_SERVICE_BASE_URL`, `TRANSCRIPTION_SERVICE_API_KEY`
- `sessionTokenConfig.signingKey` ← `SESSION_TOKEN_SIGNING_KEY`

Plus the same `--dev` flag and schema-rejection cases.

Follow the existing style (`describe`/`it`, Arrange-Act-Assert, `#src/...` import alias) shown in
`apps/session-manager/tests/unit/utils/pagination.test.ts`.

---

## Work Items (SUPPRESS)

These are process entrypoints — a top-level `await main()` that calls `fastify.listen()`. Unit
testing them requires mocking the entire server and yields ~no signal. Standard practice is to
exclude them from coverage so they stop dragging the health rating.

Files:
- `apps/session-manager/src/index.ts`
- `apps/node-server/src/index.ts`
- `libs/base-fastify-server/src/index.ts` (barrel) — and optionally `create-base-server.ts` /
  `create-logger.ts` if the team prefers to lean on the lib's integration tests rather than add
  unit coverage.

How (Vitest — in each package's `vitest.config.ts`):

```ts
test: {
  coverage: {
    exclude: [
      'src/index.ts',        // bootstrap entrypoint
      // base-fastify-server also: 'src/server/create-logger.ts', 'src/server/create-base-server.ts'
    ],
  },
}
```

After excluding, these packages simply disappear from the report instead of showing a ❌ — an honest
signal, since there is no realistic unit test to write for them.

---

## Recommended sequencing

1. Add the two `app-config` unit tests (real coverage gain, closes the only true "untested code" ❌).
2. Add the coverage `exclude` for the `index.ts` entrypoints.
3. Leave everything else — it is already covered by the sibling (integration/unit) suite; writing
   duplicate tests would add maintenance cost with no real risk reduction.
