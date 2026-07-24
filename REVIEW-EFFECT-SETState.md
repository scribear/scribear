# REVIEW-EFFECT-SETState.md

Sites flagged by the `react-hooks/set-state-in-effect` / `@eslint-react/set-state-in-effect`
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
a data-fetch loading flag.

## Resolution

Decision taken: **introduce a shared `useAsyncData` hook** (`src/lib/use-async-data.ts`) that owns
the `loading` / `error` / `data` transition plus the mounted-guard, and refactor the sites that fit
it. The hook derives page-specific branches (not-found, misconfiguration, …) from its `error` return
during render instead of storing them as separate effect-written state, and exposes `reload()` for
post-mutation refresh. The single unavoidable synchronous `setState`-in-effect (the loading flag)
lives **once**, inside the hook, suppressed there — so both `set-state-in-effect` rules stay live
(errors, not disabled) for all new code elsewhere.

Not every flagged site fits that shape. Sites were converted only where `useAsyncData` cleanly
models the fetch; the rest keep their per-line suppressions as **deliberate, documented exceptions**
(not untriaged debt). "Correctness and behavior-preservation beat coverage" was the rule — a forced
fit that changes behavior or fragments a coherent effect is worse than a suppressed line.

### One behavior change on converted pages

On pages where a **mutation** handler previously set a `misconfigured`/`notFound` banner in its
`catch`, that state no longer exists (it is now derived from the *load* `error`). A misconfiguration
raised by a mutation now surfaces as a **toast** (carrying the API error's own message) rather than
the persistent inline banner. This is arguably more correct — the banner was really about the load
path — but it is a change, called out here for reviewers. The load-path banner behavior is
unchanged.

## All flagged sites

| # | File : line | Status |
|---|---|---|
| 1 | `components/activation-code-display.tsx:40` | **Kept** — countdown timer, not a fetch; a legit `setInterval` tick loop. |
| 2 | `features/audit/audit-page.tsx:41` | **Resolved** — `useAsyncData`. |
| 3 | `features/config-check/config-check-page.tsx:167` | **Resolved** — `useAsyncData` (hook's `reload()` drives the "Re-run" button). |
| 4 | `features/devices/device-detail-page.tsx:171` | **Resolved** — `useAsyncData` (device fetch). |
| 5 | `features/devices/device-detail-page.tsx:172` | **Resolved** — same effect. |
| 6 | `features/devices/device-detail-page.tsx:173` | **Resolved** — same effect. |
| 7 | `features/devices/device-detail-page.tsx:201` | **Resolved** — `useAsyncData` (dependent room lookup). |
| 8 | `features/devices/devices-list-page.tsx:216` | **Kept** — paginated: "Load more" appends into the same state via `setDevices(prev => [...prev, ...])`; `useAsyncData` owns its `data` and can't be appended to externally. |
| 9 | `features/kiosk-setup/kiosk-wizard-page.tsx:387` | **Kept** — conditional once-only fetch guard (`roomChoice !== 'existing' \|\| existingRooms.length > 0`), and `roomMisconfigured` is shared state written by the effect *and* two mutation handlers. |
| 10 | `features/kiosk-setup/schedule-step.tsx:473` | **Kept** — `Promise.all` of three endpoints into six states; `schedules`/`windows` are optimistically appended by create handlers and `autoEnabled`/form state are locally mutated. |
| 11 | `features/rooms/room-detail-page.tsx:316` | **Resolved** — `useAsyncData` (main page). The `AddDeviceDialog`/`RenameRoomDialog` fetches are *not* flagged and keep their own mutation-driven `misconfigured`, so they were left as-is. |
| 12 | `features/rooms/rooms-list-page.tsx:247` | **Kept** — paginated (same append pattern as devices-list). |
| 13 | `features/scheduling/room-scheduling-page.tsx:1032` | **Kept** — one effect fires three parallel fetches into three slices; the `roomDetail` slice is mutated by handlers (`setRoom`), so it can't live inside `useAsyncData`. |
| 14 | `features/scheduling/room-scheduling-page.tsx:1033` | **Kept** — same effect. |
| 15 | `features/scheduling/room-scheduling-page.tsx:1034` | **Kept** — same effect. |
| 16 | `features/sessions/session-detail-page.tsx:87` | **Resolved** — `useAsyncData` (reference conversion). |
| 17 | `features/sessions/session-detail-page.tsx:88` | **Resolved** — same effect. |
| 18 | `features/sessions/session-detail-page.tsx:89` | **Resolved** — same effect. |

**Resolved:** 10 flagged sites across 5 files (audit, config-check, device-detail, room-detail,
session-detail). **Kept** (deliberate, documented): 8 flagged sites across 6 files.

### Also migrated to `useAsyncData` (were not flagged, but a clean fit)

- `features/dashboard/dashboard-page.tsx` — two parallel single-fetches; shared `misconfigured`
  banner derived from either error.
- `lib/use-room-name-lookup.ts` — single async that paginates internally and returns a `Map`.

### Considered and left unconverted (bad fit, and not flagged)

- `features/dashboard/use-fleet.ts` — `GET /fleet` seed + `/fleet/stream` SSE deltas with bespoke
  `available`/`connected` semantics; not a single-value fetch.
- `features/auth/auth-provider.tsx` — bootstrap effect: two sequential fetches, imperative side
  effects (`setCsrfToken`, `setOnUnauthorized`), three state slices.

## Duplicate vs. distinct: how the two rules overlap

`react-hooks/set-state-in-effect` (error) and `@eslint-react/set-state-in-effect` (warning) are two
independent rules, from two different plugins, that both target this same pattern. They do **not**
always fire on the same line:

- **11 of the 18 lines** are flagged by **both** rules on the same line.
- **7 of the 18 lines** are flagged **only** by `@eslint-react/set-state-in-effect` — these are the
  *second and third* synchronous `setState` calls in an effect that makes several in a row
  (`react-hooks/set-state-in-effect` reports only the first offending call per effect;
  `@eslint-react/set-state-in-effect` reports every one).

This is why a kept site with several synchronous setters carries a both-id disable on the first and
an `@eslint-react`-only disable on the rest; the `useAsyncData` hook follows the same convention
internally.
