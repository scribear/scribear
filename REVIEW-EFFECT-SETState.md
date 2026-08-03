# REVIEW-EFFECT-SETState.md

Sites flagged by the `react-hooks/set-state-in-effect` / `@eslint-react/set-state-in-effect`
rules (new in `eslint-plugin-react-hooks` 7.1 and `@eslint-react/eslint-plugin` 5, surfaced by
[PR #144](https://github.com/scribear/scribear/pull/144), the ESLint 9→10 / eslint-react 2→5
dependency bump). All 18 originally-flagged sites are in `admin-webapp`.

17 of the 18 were the same "loading flag" data-fetching idiom:

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

The 18th (`activation-code-display.tsx:40`) is a countdown-timer effect (`setInterval` tick), not a
data-fetch loading flag.

## Resolution

Two shared hooks now own the loading/error/data transition and the mounted-guard that was
hand-rolled across these pages:

- **`src/lib/use-async-data.ts`** — single-value fetch. Runs on mount and when `deps` change,
  exposes `{ data, loading, error, reload }`. Callers derive page-specific branches (not-found,
  misconfiguration, …) from `error` during render instead of storing them as effect-written state,
  and use `reload()` for post-mutation refresh.
- **`src/lib/use-async-list.ts`** — cursor-paginated sibling. Adds `loadingMore` / `hasMore` /
  `loadMore()` for "Load more" append-style lists.

The one synchronous `setState`-in-effect the loading idiom needs lives **once**, inside each hook,
suppressed there — so both `set-state-in-effect` rules stay live (errors, not disabled) for all new
code elsewhere.

**Every data-fetch site has been migrated.** The only two remaining per-line suppressions are
deliberate, documented exceptions where the hook model genuinely does not fit (see the table).

### Behavior changes on converted pages

1. **Mutation-raised misconfiguration → toast.** Where a *mutation* handler previously set a
   `misconfigured`/`notFound` banner in its `catch`, that state is now derived from the *load*
   `error`. A misconfiguration raised by a mutation surfaces as a **toast** (with the API error's
   message) rather than the persistent inline banner. Load-path banners are unchanged. (The kiosk
   wizard is the exception: its room-step banner keeps exact behavior — the mutation-set flag is
   preserved and combined with the derived load error via `roomStepMisconfigured`.)
2. **Post-mutation refresh is a refetch.** A handful of handlers that updated a record *in place*
   from a mutation's return value (`device-detail` rename, `room-scheduling` auto-session toggle)
   now call `reload()`. Same end state, one extra request and a brief window showing the prior
   value.

## All originally-flagged sites

| # | File : line | Status |
|---|---|---|
| 1 | `components/activation-code-display.tsx:40` | **Kept** — countdown `setInterval` tick, not a fetch. |
| 2 | `features/audit/audit-page.tsx:41` | **Resolved** — `useAsyncData`. |
| 3 | `features/config-check/config-check-page.tsx:167` | **Resolved** — `useAsyncData` (hook's `reload()` drives the "Re-run" button). |
| 4–6 | `features/devices/device-detail-page.tsx:171–173` | **Resolved** — `useAsyncData` (device fetch). |
| 7 | `features/devices/device-detail-page.tsx:201` | **Resolved** — `useAsyncData` (dependent room lookup). |
| 8 | `features/devices/devices-list-page.tsx:216` | **Resolved** — `useAsyncList` (cursor pagination). |
| 9 | `features/kiosk-setup/kiosk-wizard-page.tsx:387` | **Resolved** — `useAsyncData`; fetcher no-ops until "existing" is picked; banner combined so mutation behavior is unchanged. |
| 10 | `features/kiosk-setup/schedule-step.tsx:473` | **Kept** — `schedules`/`windows` are *optimistically appended* by the create handlers (no refetch) and `autoEnabled` is toggled locally; `useAsyncData` owns its `data` and can't model optimistic mutation. Converting would trade optimistic UI for a refetch. |
| 11 | `features/rooms/room-detail-page.tsx:316` | **Resolved** — `useAsyncData` (main page). The dialogs' non-flagged fetches keep their own mutation-driven `misconfigured`. |
| 12 | `features/rooms/rooms-list-page.tsx:247` | **Resolved** — `useAsyncList`. |
| 13–15 | `features/scheduling/room-scheduling-page.tsx:1032–1034` | **Resolved** — three `useAsyncData` slices (room / schedules / windows); `loadSchedules`/`loadWindows` became `reload`s. Refetch-based, so it fits (unlike schedule-step). |
| 16–18 | `features/sessions/session-detail-page.tsx:87–89` | **Resolved** — `useAsyncData` (reference conversion). |

**Resolved:** 16 of the 18 flagged sites. **Kept** (deliberate, documented): 2 — the countdown
timer and schedule-step's optimistic-append effect.

### Also migrated (were not flagged, but a clean fit)

- `features/dashboard/dashboard-page.tsx` — two parallel single-fetches; shared `misconfigured`
  banner derived from either error.
- `lib/use-room-name-lookup.ts` — single async that paginates internally and returns a `Map`.

### Considered and left unconverted (bad fit, and not flagged)

- `features/dashboard/use-fleet.ts` — `GET /fleet` seed + `/fleet/stream` SSE deltas with bespoke
  `available`/`connected` semantics; not a single-value fetch.
- `features/auth/auth-provider.tsx` — bootstrap effect: two sequential fetches, imperative side
  effects (`setCsrfToken`, `setOnUnauthorized`), three state slices.

## Pre-existing warnings (out of scope)

`room-scheduling-page.tsx:236` and `:573` carry `@eslint-react/use-state` lazy-init warnings in the
dialog form-state initializers. These predate this work and are unrelated to `set-state-in-effect`;
left as-is.

## Duplicate vs. distinct: how the two rules overlap

`react-hooks/set-state-in-effect` (error) and `@eslint-react/set-state-in-effect` (warning) are two
independent rules that both target this pattern but do **not** always fire on the same line:
`react-hooks/set-state-in-effect` reports only the first offending call per effect;
`@eslint-react/set-state-in-effect` reports every one. That is why a kept site with several
synchronous setters carries a both-id disable on the first and an `@eslint-react`-only disable on
the rest; the shared hooks follow the same convention internally.
