# TypeScript 6.0.3 Upgrade Summary

Upgraded the `scribear` monorepo's TypeScript dependency from **5.9.3** to **6.0.3**.

## Changes Made

### `package.json`
- Bumped the root devDependency `"typescript": "5.9.3"` → `"typescript": "6.0.3"`.
- TypeScript is declared once at the repo root; all workspaces consume it via the hoisted `node_modules` install, so no per-workspace `package.json` edits were required.

### `package-lock.json`
- Updated the `node_modules/typescript` entry to `6.0.3` (new resolved URL + integrity hash).
- **`tsconfck` hoisting change (benign):** `tsconfck@3.1.6` (a transitive dependency of `vite-tsconfig-paths`) declares an *optional* peer dependency of `typescript: ^5.0.0`. Because the root TypeScript is now `6.0.3` (outside that range), npm could no longer dedupe `tsconfck` at the top level and instead nested it under `node_modules/vite-tsconfig-paths/node_modules/tsconfck`. `tsconfck` uses TypeScript only as an optional peer (it parses `tsconfig.json` files itself), so this is purely a layout change and does not affect behavior.

### No code or `tsconfig.json` changes required
The existing `tsconfig.base.json` was already configured in a way that is compatible with the new TS 6.0 defaults. No source files or `tsconfig*.json` files needed editing.

## Why No Config Changes Were Needed

TypeScript 6.0 changed several compiler-option defaults and deprecated some legacy options. The table below records each relevant breaking/deprecation change from the [TS 6.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/) and the status of this repo.

| TS 6.0 change | This repo's existing setting | Impact |
|---|---|---|
| `types` now defaults to `[]` (was: all `@types`) | `tsconfig.base.json` already sets `"types": ["node"]` | None — explicit list already present |
| `rootDir` now defaults to `.` (was: inferred common dir) | Every workspace `tsconfig.json` already sets `"rootDir": "."` | None — already explicit |
| `strict` now defaults to `true` | `tsconfig.base.json` already sets `"strict": true` | None |
| `module` now defaults to `esnext` | `tsconfig.base.json` already sets `"module": "nodenext"` | None |
| `target` now defaults to current-year ES | `tsconfig.base.json` already sets `"target": "es2024"` | None |
| `noUncheckedSideEffectImports` now defaults to `true` | `tsconfig.base.json` already sets it to `true` | None |
| `libReplacement` now defaults to `false` | Not configured (uses new default) | None — no custom lib replacement in use |
| `esModuleInterop: false` / `allowSyntheticDefaultImports: false` deprecated | `esModuleInterop: true` already set | None |
| `alwaysStrict: false` deprecated | Not set (inherits `strict: true`) | None |
| `--baseUrl` deprecated | Not used anywhere | None |
| `--moduleResolution node`/`classic` deprecated | Uses `nodenext` | None |
| `target: es5` / `--downlevelIteration` deprecated | Target is `es2024` | None |
| `module: amd/umd/systemjs/none` deprecated | Uses `nodenext` | None |
| `--outFile` removed | Not used | None |
| Legacy `module {}` namespace syntax deprecated | Not used | None |
| `asserts` import keyword deprecated | Not used (no import assertions) | None |
| `no-default-lib` directive removed | Not used | None |
| `dom` lib now absorbs `dom.iterable`/`dom.asynciterable` | `tsconfig.base.json` lists `"dom.iterable"` | **Redundant but harmless** — `dom.iterable` is now an empty file. Left in place to keep the diff minimal and preserve backward compatibility with TS 5.x; can be removed in a future cleanup. |

### Tooling compatibility
- `typescript-eslint@8.65.0` declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"`, so TS 6.0.3 is within the supported range. Linting passed without changes.

## Verification

After the upgrade, a clean full rebuild and the full test suite were run from the repo root:

| Check | Command | Result |
|---|---|---|
| Type-check / build (`tsc --build` across all workspaces) | `npm run build` | Pass |
| Unit tests (Vitest, all workspaces) | `npm run test:unit` | Pass |
| Integration tests (Vitest, all workspaces) | `npm run test:integration` | Pass |
| Lint (ESLint + typescript-eslint) | `npm run lint` | Pass |

Build artifacts (`dist/`) and `.tsbuildinfo` files were deleted before the rebuild to ensure a full type-check rather than an incremental skip.

## Environmental Note (not committed)

While establishing the pre-upgrade baseline, the local `node_modules` was found to be out of sync with the committed `package-lock.json`: `@mui/material` and `@mui/icons-material` were resolved to `9.2.0` in `node_modules` while both `package.json` and `package-lock.json` pin `7.3.8`. MUI 9 removed several system-style props (e.g. `alignItems`, `fontWeight`), which produced spurious type errors in `libs/ui/*`. Running `npm ci` restored the lockfile-pinned MUI `7.3.8` and the baseline build/test suite passed. This was a local-install staleness issue, not a repository defect — no `package.json`/lockfile changes resulted from it.

---

## npm Audit Follow-Up (separate commit)

After the TypeScript upgrade, `npm audit` reported **13 vulnerabilities** (1 moderate, 12 high) in three groups. Two groups were resolved with `overrides` in the root `package.json`; the third was evaluated and deliberately left in place. The result is **2 high** remaining (both in the not-applicable `react-router` advisory).

### 1. `brace-expansion` — FIXED (override)

- **Advisory:** CVE-2026-14257 / GHSA-mh99-v99m-4gvg — DoS via unbounded brace-expansion length causing an uncatchable out-of-memory crash. Affected `<= 5.0.7`; patched in `5.0.8`.
- **Exposure in this repo:** dev/test-only — reached transitively via `@trivago/prettier-plugin-sort-imports` → `minimatch@9` and `testcontainers` → `archiver` → `readdir-glob` → `minimatch@5`. No production runtime path.
- **Fix:** added `"brace-expansion": "5.0.8"` to `overrides`. `5.0.8` is a backward-compatible patch (adds an output-length bound + `maxLength` option; the public `expand()` API is unchanged). This deduped the legacy `2.x` copy that `minimatch@9`/`minimatch@5` previously pulled in.

### 2. `@fastify/static` — FIXED (override)

- **Advisories:** GHSA-8pvw-jcv7-9cmj (authorization bypass via non-canonical URL paths) and GHSA-83w8-p2f5-377r (route-guard bypass via path traversal). Affected `<= 10.1.1`; patched in `10.1.2`.
- **Exposure in this repo:** production runtime — `@fastify/swagger-ui@5.2.5` (used by `node-server` and `session-manager`) depends on `@fastify/static@^9.0.0`, which resolves to the vulnerable `9.3.0`. Even the latest `@fastify/swagger-ui` (6.1.0) still pins `^9.1.2`, so there is no upstream fix.
- **Fix:** added `"@fastify/static": "10.1.2"` to `overrides`. The only breaking change in `@fastify/static` 10.0 is the `setHeaders` callback signature (`FastifyReply` instead of `Response`); `@fastify/swagger-ui` does not use `setHeaders` (confirmed by inspecting its source), and the project does not depend on `@fastify/static` directly.
- **Lockfile note:** npm's incremental installer would not apply this override on its own (overriding `9.3.0` → `10.1.2` introduces a new transitive dep, `content-disposition@2.0.1`, that the existing lockfile didn't contain). A full lockfile regeneration was blocked by a pre-existing peer-dependency conflict (`react-dom` resolves to `19.2.8` on a clean resolve, whose peer `react@^19.2.8` clashes with the pinned `react@19.2.5`). The lockfile was therefore updated surgically: the `node_modules/@fastify/static` entry was rewritten to `10.1.2` and the single new nested entry `node_modules/@fastify/static/node_modules/content-disposition@2.0.1` was added. `npm ci` validates cleanly and `npm install` reproduces the tree.
- **Verification:** the swagger integration tests in both `node-server` and `session-manager` (`tests/integration/swagger.test.ts`) pass against `@fastify/static@10.1.2`.

### 3. `react-router` — NOT APPLICABLE (documented, no change)

- **Advisory:** GHSA-qwww-vcr4-c8h2 — RSC-mode CSRF bypass. Affected `>= 7.12.0, < 8.3.0`; patched only in `8.3.0`.
- **Exposure in this repo:** the advisory states "This only affects your application if you are using the unstable RSC APIs." `admin-webapp` (the sole consumer of `react-router-dom@7.18.1`) is a standard client-side SPA using `BrowserRouter`/`Routes`/`Route`/`NavLink`/`useNavigate`/`useParams` — it does **not** use RSC or any unstable APIs. No exploitable path exists.
- **Why not upgraded:** the only patched version is `react-router@8.3.0`. React Router 8 dropped the `react-router-dom` package entirely (the app imports from `react-router-dom` in 16 files), and `react-router@8.3.0` requires `react@>=19.2.7`/`react-dom@>=19.2.7` while the project pins `19.2.5`. Fixing this advisory would require a major router migration (package rename + import rewrites) **and** a React version bump, for a vulnerability that does not apply to this application. Left as-is pending a planned React/Router upgrade.

### Verification after audit fixes

| Check | Command | Result |
|---|---|---|
| Build (`tsc --build` across all workspaces) | `npm run build` | Pass |
| Unit tests | `npm run test:unit` | Pass |
| Integration tests (incl. swagger suites) | `npm run test:integration` | Pass |
| Lint | `npm run lint` | Pass |
| Clean install from lockfile | `npm ci` | Pass |
| `npm audit` | `npm audit` | 2 high (react-router, not applicable) |

