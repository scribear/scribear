# REVIEW-EFFECT-SETState.md

Sites flagged by the new `react-hooks/set-state-in-effect` / `@eslint-react/set-state-in-effect`
rules (new in `eslint-plugin-react-hooks` 7.1 and `@eslint-react/eslint-plugin` 5, surfaced by
[PR #144](https://github.com/scribear/scribear/pull/144), the ESLint 9→10 / eslint-react 2→5
dependency bump). All 18 sites below are in `admin-webapp`.

17 of the 18 are the same "loading flag" data-fetching idiom:

```ts
useEffect(() => {
  const alive = { current: true };
  setLoading(true);          // <- flagged here
  adminApi.listX(...)
    .then((res) => { ... })
    .catch((err) => { ... showError(...) })
    .finally(() => { if (alive.current) setLoading(false); });
  return () => { alive.current = false; };
}, [deps]);
```

The 18th (`activation-code-display.tsx:40`) is a different pattern — a countdown-timer effect that
calls `setRemainingMs` from a `tick()` function invoked both immediately and on a `setInterval`, not
a data-fetch loading flag. It's included here because it's flagged by the same rule, but it may
warrant a different resolution than the other 17.

There is no prior precedent in this codebase either way for how to handle synchronous `setState`
calls at the top of an effect body. This needs a deliberate design decision — disable the rule(s)
(repo-wide or per-file), keep per-site suppressions long-term, or refactor to a shared hook (e.g. a
`useAsyncQuery`-style hook that owns the loading/error/data state transition) — not resolved in the
dependency-bump PR. Each site below currently carries a per-line `eslint-disable` comment pointing
back to this file so the rule stays live for new code elsewhere.

## Duplicate vs. distinct: how the two rules overlap

`react-hooks/set-state-in-effect` (error) and `@eslint-react/set-state-in-effect` (warning) are two
independent rules, from two different plugins, that both target this same pattern. They do **not**
always fire on the same line:

- **11 of the 18 lines** below are flagged by **both** rules, on the literal same line — i.e. the
  `react-hooks/set-state-in-effect` error and the `@eslint-react/set-state-in-effect` warning point
  at the exact same `setX(...)` call.
- **7 of the 18 lines** are flagged **only** by `@eslint-react/set-state-in-effect`. These are all
  the *second and third* synchronous `setState` calls in an effect that makes several in a row
  (`react-hooks/set-state-in-effect` appears to only report the first offending call per effect;
  `@eslint-react/set-state-in-effect` reports every one).

## All flagged sites

| # | File : line | Rule(s) firing on this line |
|---|---|---|
| 1 | `apps/admin-webapp/src/components/activation-code-display.tsx:40` | `@eslint-react/set-state-in-effect` only |
| 2 | `apps/admin-webapp/src/features/audit/audit-page.tsx:41` | both |
| 3 | `apps/admin-webapp/src/features/config-check/config-check-page.tsx:167` | both |
| 4 | `apps/admin-webapp/src/features/devices/device-detail-page.tsx:171` | both |
| 5 | `apps/admin-webapp/src/features/devices/device-detail-page.tsx:172` | `@eslint-react/set-state-in-effect` only |
| 6 | `apps/admin-webapp/src/features/devices/device-detail-page.tsx:173` | `@eslint-react/set-state-in-effect` only |
| 7 | `apps/admin-webapp/src/features/devices/device-detail-page.tsx:201` | both (second, unrelated effect in the same file) |
| 8 | `apps/admin-webapp/src/features/devices/devices-list-page.tsx:216` | both |
| 9 | `apps/admin-webapp/src/features/kiosk-setup/kiosk-wizard-page.tsx:387` | both |
| 10 | `apps/admin-webapp/src/features/kiosk-setup/schedule-step.tsx:473` | both |
| 11 | `apps/admin-webapp/src/features/rooms/room-detail-page.tsx:316` | both |
| 12 | `apps/admin-webapp/src/features/rooms/rooms-list-page.tsx:247` | both |
| 13 | `apps/admin-webapp/src/features/scheduling/room-scheduling-page.tsx:1032` | both |
| 14 | `apps/admin-webapp/src/features/scheduling/room-scheduling-page.tsx:1033` | `@eslint-react/set-state-in-effect` only |
| 15 | `apps/admin-webapp/src/features/scheduling/room-scheduling-page.tsx:1034` | `@eslint-react/set-state-in-effect` only |
| 16 | `apps/admin-webapp/src/features/sessions/session-detail-page.tsx:87` | both |
| 17 | `apps/admin-webapp/src/features/sessions/session-detail-page.tsx:88` | `@eslint-react/set-state-in-effect` only |
| 18 | `apps/admin-webapp/src/features/sessions/session-detail-page.tsx:89` | `@eslint-react/set-state-in-effect` only |

11 distinct effects (one file, `device-detail-page.tsx`, has two separate flagged effects), across
8 files, all in `admin-webapp`.
