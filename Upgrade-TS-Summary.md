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
