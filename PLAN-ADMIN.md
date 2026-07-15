# PLAN-ADMIN — ScribeAR Admin Website

A plan for an **admin website for IT professionals** to operate the ScribeAR
Session Manager: create/list/rename/delete rooms and devices, set up kiosks,
manage schedules and sessions, and see health/status/error information — securely.

> Status: proposal / design. Nothing here is built yet. This document is the
> source of truth for scope, architecture, and phased delivery. Owner: TBD.

---

## 1. Goals & non-goals

### Goals
- Give IT staff a **web UI** replacing the current `curl` + `deployment/*.sh` workflow.
- Support the **common operations**:
  - Rooms: create, list/search, view, rename, delete, manage member devices, set source device.
  - Devices: register, list/search, view, rename, delete, re-register (rotate credential).
  - **Kiosk setup**: guided flow that registers a device, shows the activation code, and assigns it to a room as source.
  - Schedules & sessions: create/list/edit/delete recurring schedules and auto-session windows; create on-demand sessions; start/end sessions early; toggle a room's auto-session master switch.
- Be **secure**: the admin API key must never reach the browser; authenticate individual IT staff; audit who did what.
- **Report clearly**: surface successes, validation errors, failures, service health, and any available status/performance info.
- Match the repo's existing **stack and conventions** (npm workspaces, React 19 + Vite + MUI + Redux Toolkit, nginx-served, Docker Compose deploy).

### Non-goals (initial release)
- End-user (viewer/participant) features — those already live in `client-webapp`/`kiosk-webapp`.
- Replacing session-manager's auth model wholesale (we adapt around it; targeted hardening is listed in §11).
- Multi-tenant org management beyond what the current schema supports.
- Editing transcription-provider model configs beyond passing through `transcriptionProviderId` / `transcriptionStreamConfig`.

---

## 2. Current-state findings (from code review)

### 2.1 Where the admin API lives
The admin API is the **Session Manager** service (`apps/session-manager`), not `node-server`
(which only proxies transcription websockets). Base path:

```
/api/session-manager/v1
```

Served as plain HTTP on `:8001`; TLS + routing handled by nginx
(`infra/scribear-nginx/nginx.conf`, location `/api/session-manager/`).

### 2.2 API surface (40 routes; 29 are admin-guarded)
Guards are Fastify `preHandler` hooks (`apps/session-manager/src/server/hooks/`):

| Audience | Credential | Transport |
|---|---|---|
| **Admin** (`adminApiKeyHook`) | `ADMIN_API_KEY` | `Authorization: Bearer <key>` |
| Service (`serviceApiKeyHook`) | `SESSION_MANAGER_SERVICE_API_KEY` | `Authorization: Bearer <key>` |
| Device (`deviceTokenHook`) | `DEVICE_TOKEN` cookie (`{uid}:{secret}`, bcrypt) | HTTP-only cookie |
| Public | join code / refresh token / activation code, or none | request body |

**The 29 admin-guarded routes** (the admin site's entire target surface):

- **Device Management** (6): `list-devices` (paginated; filters `search`, `active`, `roomUid`), `get-device/:uid`, `register-device`, `reregister-device`, `update-device`, `delete-device`.
- **Room Management** (8): `list-rooms` (paginated; `search`), `get-room/:uid`, `create-room`, `update-room`, `delete-room`, `add-device-to-room`, `remove-device-from-room`, `set-source-device`.
- **Schedule Management** (15): `list-schedules`/`create-schedule`/`get-schedule/:uid`/`update-schedule`/`delete-schedule`; `list-auto-session-windows`/`create-…`/`get-…/:uid`/`update-…`/`delete-…`; `update-room-schedule-config`; `get-session/:uid`, `create-on-demand-session`, `start-session-early`, `end-session-early`.

Not for the admin site: `activate-device`, `get-my-device`, `get-my-room`, `my-schedule`,
`fetch-join-code`, `exchange-device-token`, `exchange-join-code`, `refresh-session-token`,
`session-config-stream`, `liveness`, `readiness`.

Conventions: reads are `GET` (single-entity fetch uses a path param); **all mutations are
`POST` with a JSON body** (no PUT/PATCH/DELETE). Only `list-devices`/`list-rooms` paginate
(cursor + limit 1–200 default 50; envelope `{ items, nextCursor }`). Two "streaming" routes
are HTTP long-poll, not WebSocket — and neither is admin-facing.

### 2.3 Domain model (for UI shapes)
- **Device**: `{ uid, name, active, roomUid|null, isSource|null, createdAt }`. Lifecycle is
  **pending** (`active=false`, has one-time `activationCode`+`expiry`) → **activated**
  (`active=true`, holds a bcrypt device-token hash). A device belongs to **≤1 room**.
- **Room**: `{ uid, name, timezone (IANA), autoSessionEnabled, roomScheduleVersion, createdAt }`.
  A room must always have **≥1 source device** (v1: exactly one). Deleting a room cascades
  its memberships, schedules, sessions.
- **RoomDevice** join: `is_source` marks the audio source; unique on `device_uid`.
- **Session**: `{ uid, roomUid, name, type (SCHEDULED|ON_DEMAND|AUTO), scheduled/effective start&end, startOverride/endOverride, joinCodeScopes[], transcriptionProviderId, transcriptionStreamConfig, sessionConfigVersion, createdAt }`. Sessions in a room **cannot overlap** in time (DB exclusion constraint). `effectiveStart/End` fold in manual overrides.
- **Schedule** (recurring template): frequency `ONCE|WEEKLY|BIWEEKLY`, `daysOfWeek[]`, local start/end times (room tz), active window.
- **AutoSessionWindow**: recurring windows that fill gaps with `AUTO` sessions when the room's `autoSessionEnabled` is on.
- **SessionScope**: `SEND_AUDIO`, `RECEIVE_TRANSCRIPTIONS`.

### 2.4 Reusable building blocks
- **Typed client** `@scribear/session-manager-client` — `createSessionManagerClient(baseUrl)`
  returns `{ probes, roomManagement, deviceManagement, scheduleManagement, sessionAuth }`,
  each method `(params, init?) => Promise<[response, error]>`. **No credential is embedded** —
  the caller must attach `Authorization: Bearer <key>` per call. Browser-safe (uses `fetch`/`URL`)
  but the key must be injected **server-side**.
- **Schemas** `@scribear/session-manager-schema` — TypeBox request/response schemas + OpenAPI
  metadata. Swagger UI is served at `/api-docs` **only in `--dev`**.
- **Frontend conventions** (copy `client-webapp` as the template): React `19.2.5`, Vite, MUI
  `7.3.8` + Emotion, Redux Toolkit `2.11.2` + `redux-remember`, TypeBox for URL-config, Node
  `24.10.0`, nginx-alpine runtime image. Feature-based folders; the **service + middleware**
  idiom for non-React runtime logic; typed `useAppSelector/useAppDispatch`; theme via
  `AppThemeProvider`. **No router yet** — the admin app would introduce `react-router`.
- **Current manual workflow**: `deployment/register-device.sh <name>` then
  `deployment/create-room.sh <name> <sourceDeviceUid> [tz] [auto]`, both sending
  `Authorization: Bearer $SESSION_MANAGER_API_KEY`.

### 2.5 Deployment topology
Single nginx terminates TLS and serves everything **same-origin**:
`/api/session-manager/`, `/api/node-server/`, `/client/`, `/kiosk/`, `/standalone/`.
Compose stack in `deployment/compose.yml`; images from `ghcr.io/scribear`.

---

## 3. The central constraint (drives the whole architecture)

Session Manager's admin auth is **a single static bearer key**, compared in plaintext
(`key === ADMIN_API_KEY`, `admin-auth.service.ts`). It has:

- no per-user identity, no audit of *who* acted, no revocation short of rotating the one key;
- **no CORS** configured (a cross-origin browser SPA cannot call it directly);
- **no rate limiting** anywhere;
- non-constant-time comparison and no key-strength enforcement (`CHANGEME` is accepted).

**Consequence:** we cannot ship the admin key to a browser SPA, and we cannot let the SPA call
Session Manager cross-origin. We need a **Backend-for-Frontend (BFF)** that:
holds the key server-side, authenticates individual IT staff, and proxies admin calls
same-origin. This is the recommended architecture (§4).

---

## 4. Architecture

### 4.1 Recommended: Admin SPA + Admin BFF (two new containers)

```
Browser ──HTTPS──> nginx ──> /admin/       ─> admin-webapp   (static SPA, nginx-alpine)
                        └──> /api/admin/    ─> admin-server   (BFF: auth, proxy, audit)
                                                    │
                                                    └─(server-side, Bearer ADMIN_API_KEY)─>
                                                       session-manager  /api/session-manager/v1
```

- **`apps/admin-webapp`** — React SPA, same conventions as `client-webapp`. Talks **only** to
  `/api/admin/*` on its own origin. Never sees the admin key. Holds a session cookie only.
- **`apps/admin-server`** — small Fastify BFF built on `@scribear/base-fastify-server`:
  - authenticates IT staff and issues an **HTTP-only, Secure, SameSite=strict session cookie** (+ CSRF token);
  - injects `Authorization: Bearer $ADMIN_API_KEY` and calls Session Manager via
    `@scribear/session-manager-client`;
  - exposes a thin `/api/admin/*` surface (either 1:1 proxy or task-oriented endpoints, e.g. a single "provision kiosk" call that fans out to register + assign);
  - adds **audit logging**, **rate limiting**, per-user authorization, and consistent error envelopes.

**Why the BFF:** it is the only design that satisfies "must be secure" given the static-key
model — it keeps the key server-side, gives real per-admin identity + audit, and lets us add
rate limiting/CSRF without modifying Session Manager. It also matches the same-origin nginx
topology (no CORS needed).

**Staff authentication (decided):** a **pluggable auth layer** in the BFF with two providers
behind one interface — ship the **local provider now**, add **Azure Entra ID (Azure AD) SSO
later** without reworking session/CSRF/audit. See §4.4 for the design.
- **Today — local single-account provider.** One username+password supplied via a single env var
  (`ADMIN_LOCAL_CREDENTIALS`, e.g. `engrit hag3hasdgqwy!`). If the var is empty/unset the local
  provider is **disabled** (the toggle used to force SSO-only in production).
- **Future — Azure Entra ID (OIDC) provider.** UIUC Azure AD. Real identities + MFA + central
  de-provisioning; restrict to an admin group/allowlist. Added as a second provider; everything
  downstream (session cookie, CSRF, rate limiting, audit) is provider-agnostic and unchanged.

### 4.2 Alternative (lower effort, weaker): nginx gate + header injection
Put `oauth2-proxy` or nginx basic-auth in front, and have nginx inject the admin key header on
`/api/admin/session-manager/` → session-manager. No custom BFF.
- Pros: minimal new code.
- Cons: no per-user authorization inside the app, coarse audit, no task-oriented endpoints, no
  place to add CSRF/validation/aggregation. Everything past the gate gets **full** admin power.
- Verdict: acceptable only as an interim; **not** recommended as the target.

### 4.3 Why not a pure SPA calling session-manager directly
Would require shipping the admin key to the browser and enabling CORS — both unacceptable given
§3. Rejected.

### 4.4 Authentication design (pluggable: local now, Azure Entra ID later)

The BFF authenticates a **staff identity** and then issues its **own** session — the identity
*source* is swappable, the session machinery is not. This keeps the future Azure work to "add one
provider", touching nothing about cookies, CSRF, rate limiting, authorization, or audit.

```
AuthProvider (interface)                       Session layer (provider-agnostic)
  ├─ LocalAuthProvider    ── verify() ─┐        ├─ issueSession(identity) → HttpOnly cookie + CSRF token
  └─ AzureOidcProvider    ── verify() ─┴──────► ├─ requireSession()  (guards /api/admin/*)
     (future)                                    ├─ audit(actor = identity)
                                                 └─ logout()
```

- **`Identity`** = `{ subject, displayName, provider, roles }`. The rest of the BFF only ever sees
  an `Identity`, never a provider-specific credential.

**Local provider (build now):**
- Reads **one** env var `ADMIN_LOCAL_CREDENTIALS` = `"<username> <password>"`, **split on the first
  space only** so the password may contain spaces (`hag3hasdgqwy!` in the example has none, but the
  rule keeps it safe). Example: `ADMIN_LOCAL_CREDENTIALS="engrit hag3hasdgqwy!"` → user `engrit`.
- **Empty or unset ⇒ local login disabled** (provider not registered). This is the switch that
  makes the deployment SSO-only once Azure lands.
- Endpoint `POST /api/admin/auth/login` `{ username, password }`. Compare both fields with
  `crypto.timingSafeEqual` (constant-time; do **not** early-return on username mismatch). On success
  issue the session; map the local user to a fixed `roles` set (single admin, or read-write).
- Brute-force defense: **rate-limit `/auth/login`** (per-IP + global), small fixed delay on failure,
  generic "invalid credentials" message. This is the one credential-guessing surface, so it matters.
- Never log the password; never return it; treat `ADMIN_LOCAL_CREDENTIALS` like any other secret
  (compose secret / env, not committed).

**Azure Entra ID provider (future, seams in place now):**
- Standard OIDC Authorization Code + PKCE against UIUC Entra ID. Endpoints `GET /api/admin/auth/sso/login`
  (redirect to Microsoft) and `GET /api/admin/auth/sso/callback` (exchange code → validate `id_token`
  → build `Identity` from claims; authorize by group/allowlist). Then the **same** `issueSession()`.
- Config via env only (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_REDIRECT_URI`, `ADMIN_ALLOWED_GROUP`); when unset the SSO provider isn't registered — so
  the two providers coexist and are independently toggled by presence of their env config.
- No schema/session/UI rework required to add it; the login page just gains a "Sign in with Illinois
  (Azure AD)" button alongside (or instead of) the local form.

**Login page behavior:** the SPA asks the BFF `GET /api/admin/auth/config` which returns which
providers are enabled `{ local: bool, sso: bool }`, and renders the password form and/or the SSO
button accordingly — so turning SSO on / local off is a pure env change with no frontend rebuild.

---

## 5. Admin operations → endpoint mapping

| Operation (UI) | Session Manager endpoint(s) | Notes / guardrails |
|---|---|---|
| List/search rooms | `room-management/list-rooms` | cursor pagination + `search` |
| View room detail | `get-room/:uid` + `list-devices?roomUid=…` + `list-schedules?roomUid` + `list-auto-session-windows?roomUid` | aggregate in BFF |
| Create room | `create-room` | needs `name`, IANA `timezone`, `sourceDeviceUids[]` (≥1); can chain from device register |
| Rename room | `update-room` | |
| Delete room | `delete-room` | **confirm**: cascades schedules/sessions/memberships |
| Add/remove device to room | `add-device-to-room`, `remove-device-from-room` | remove blocked (409) if it orphans the source |
| Set source device | `set-source-device` | transactional swap |
| Toggle auto-sessions | `update-room-schedule-config` | master switch |
| List/search devices | `device-management/list-devices` | filters `search`, `active`, `roomUid` (`""`=unassigned) |
| View device | `get-device/:uid` | |
| Register device | `register-device` | returns `{ deviceUid, activationCode, expiry }` — surface the code + countdown |
| Re-register (rotate) device | `reregister-device` | **confirm**: invalidates existing DEVICE_TOKEN |
| Rename device | `update-device` | |
| Delete device | `delete-device` | 409 if it is a room's source |
| **Set up a kiosk (guided)** | `register-device` → (`create-room` with the new uid **or** `add-device-to-room`+`set-source-device`) | see §6.3 wizard |
| List/create/edit/delete schedules | `list-schedules`, `create-schedule`, `get-schedule/:uid`, `update-schedule`, `delete-schedule` | time-range list; tz-aware time pickers |
| List/create/edit/delete auto windows | `list-auto-session-windows` (+ CRUD) | |
| Create on-demand session | `create-on-demand-session` | preempts AUTO; overlap constraint may 409 |
| Start/end session early | `start-session-early`, `end-session-early` | |
| View session | `get-session/:uid` | |
| Service health | `probes/liveness`, `probes/readiness` | readiness reports DB reachability |

---

## 6. UI / UX design

### 6.1 Information architecture (routes in the SPA)
```
/login                     (or SSO redirect)
/                          Dashboard — health, counts, recent activity, quick actions
/rooms                     Rooms list (search, paginate)
/rooms/:uid                Room detail — devices, source, schedules, auto-windows, sessions, actions
/devices                   Devices list (search, filter active/room)
/devices/:uid              Device detail — status, room, actions
/kiosk-setup               Guided kiosk provisioning wizard
/schedules                 (optional top-level) schedule browser, usually reached via a room
/sessions/:uid             Session detail
/audit                     Audit log (admin actions), if BFF stores it
/settings                  Current user, sign out, app/version info
```
Introduce `react-router` (first app in the repo to need it). Keep the existing
provider-composition and service+middleware conventions.

### 6.2 Screen notes
- **Dashboard**: service health tiles (liveness/readiness, DB), totals (rooms, devices,
  pending activations, active sessions now), list of activation codes expiring soon, recent
  admin actions, quick-action buttons (New room, New device, Set up kiosk).
- **Rooms list / detail**: table with server-side search + cursor pagination ("Load more").
  Detail groups member devices (with source badge), schedules, auto-windows, and current/upcoming
  sessions; inline actions with confirmation dialogs for destructive ops.
- **Devices list / detail**: status chips — `Pending` (with activation code + expiry countdown),
  `Activated`, `Unassigned` vs room name, `Source` badge. Actions: rename, (re)register, delete,
  assign to room.
- **Schedules/auto-windows editors**: timezone-aware time pickers (room tz shown explicitly),
  day-of-week multiselect, frequency, join-code scopes, transcription provider/config. Validate
  client-side against the shared TypeBox schemas before submit.

### 6.3 "Set up a kiosk" wizard (headline feature)
1. **Device** — enter a device name → `register-device`. Show the **activation code** big +
   copyable, with an expiry countdown, and instructions ("open `/kiosk` on the kiosk browser and
   enter this code"). Optionally render the same as a QR/onscreen aid.
2. **Room** — either create a new room with this device as source (`create-room`) or pick an
   existing room and `add-device-to-room` (+ `set-source-device` if it should be the source).
3. **Schedule (optional)** — offer to create a schedule / enable auto-sessions for the room.
4. **Verify** — poll `get-device/:uid` until `active=true` to confirm the kiosk activated;
   show live "waiting for activation… / activated ✓". Summ表 links to the room/device.

### 6.4 Error / success / status / performance reporting
- **Successes**: toast/snackbar on every mutation ("Room _Foo_ created", "Device deleted"),
  optimistic list refresh.
- **Validation errors**: map 422/400 to inline field errors using the schema; show the API's
  error `code`/`message` in a non-dismissive alert.
- **Domain conflicts (409)**: human-readable guidance — e.g. "Can't delete: this device is the
  source for room _X_. Reassign the source first." for delete-device/remove-from-room; "Session
  times overlap an existing session" for session ops.
- **Auth failures (401)**: BFF session expiry → redirect to login; a 401 from Session Manager to
  the BFF (bad/rotated admin key) is an **operator error** — show a distinct "backend
  misconfiguration" banner, not a login redirect.
- **Service health / status**: Dashboard tiles from `probes/*`; the BFF also exposes its **own**
  `/api/admin/health` that rolls up (BFF up? Session Manager reachable? DB ready?). Poll on an
  interval; show last-checked time.
- **Performance info**: what's realistically available today is limited — surface
  BFF→Session-Manager **request latency** (measured in the BFF, returned as timing metadata or
  logged), readiness check timing, and per-request IDs (`request-id` header the base server
  already sets) for correlation. Richer metrics (device online/offline, active-session counts
  over time) require the enhancements in §11.4 — flag them as "not available yet" rather than
  faking them.
- Every BFF response uses a **consistent envelope** `{ ok, data?, error?: { code, message, requestId } }`
  so the UI can render failures uniformly.

---

## 7. Observability & audit (BFF responsibilities)
- **Audit log**: every mutating admin action → append `{ actor, action, target, params-summary,
  result, requestId, timestamp }` to a store (Postgres table via a new migration, or structured
  logs shipped to the existing logging pipeline). Surfaced at `/audit`.
- **Structured logging**: reuse base-server pino logger; log upstream status + latency for each
  Session Manager call; propagate/generate request IDs.
- **Health rollup** endpoint as in §6.4.
- Optional: expose Prometheus-style `/metrics` from the BFF (request counts, latencies, error
  rates) for IT's existing monitoring.

---

## 8. Security requirements (acceptance checklist)
- [ ] Admin API key **only** in `admin-server` env; never in any browser bundle, URL, or SPA config.
- [ ] Staff auth via the pluggable provider layer (§4.4): local env-account now, Azure Entra ID SSO later. `ADMIN_LOCAL_CREDENTIALS` empty/unset disables local login; SSO restricted to an admin group/allowlist.
- [ ] Local login is constant-time-compared and **rate-limited**; SSO uses Auth Code + PKCE and validates `id_token` + group claim.
- [ ] BFF session cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, short idle + absolute lifetime, server-side revocable.
- [ ] **CSRF protection** on all state-changing BFF routes (double-submit token or SameSite+origin check).
- [ ] **Rate limiting** on the BFF (login attempts and admin actions).
- [ ] Input validation on the BFF using the shared TypeBox schemas before hitting Session Manager.
- [ ] Strict security headers/CSP for the admin origin (tighter than default helmet; no inline script if feasible).
- [ ] All traffic HTTPS (nginx); HSTS on.
- [ ] Audit trail for every mutation (who/what/when/result).
- [ ] Least privilege: consider read-only vs read-write admin roles in the BFF.
- [ ] Secrets via env/compose secrets, not committed; enforce a strong `ADMIN_API_KEY` (document rotation).
- [ ] No admin key, tokens, or PII in client logs or error messages returned to the browser.

---

## 9. Implementation phases

### Phase 0 — Decisions & scaffolding
- Resolve remaining Open Decisions (§13): BFF-vs-nginx-gate, 1:1-proxy-vs-task-endpoints, roles,
  audit storage. (Auth is decided — §4.4.)
- Scaffold `apps/admin-webapp` (copy `client-webapp`) and `apps/admin-server` (copy a base-fastify
  service, e.g. structure of `session-manager`), wire into workspaces, tsconfig references, eslint.

### Phase 1 — BFF core
- **Pluggable auth layer** (§4.4): `AuthProvider` interface + session/CSRF/audit machinery, with the
  **local env-account provider** implemented (`ADMIN_LOCAL_CREDENTIALS`, timing-safe compare,
  login rate limit, `/auth/login`, `/auth/config`, `/auth/logout`). Leave the `AzureOidcProvider`
  as a stub/interface so it drops in later. Session cookie + CSRF + rate limiting.
- Session Manager client wiring with server-side key injection; consistent error envelope.
- `/api/admin/health` rollup; structured logging + request-id propagation; audit-log store + writes.
- Proxy/task endpoints for **rooms** and **devices** first.

### Phase 2 — SPA core + rooms/devices
- App shell: router, layout/nav, auth guard, theme, toasts, error boundary, health tiles.
- Rooms: list/search/paginate, detail, create, rename, delete, membership + source management.
- Devices: list/filter, detail, register (activation-code display), rename, re-register, delete.
- Full success/error/conflict reporting per §6.4.

### Phase 3 — Kiosk setup wizard
- Multi-step wizard (§6.3) incl. activation-code display + activation polling.
- Optional "provision kiosk" aggregate endpoint in the BFF.

### Phase 4 — Schedules & sessions
- Schedule + auto-window CRUD with tz-aware editors; auto-session toggle.
- On-demand session create; start/end early; session detail.

### Phase 5 — Observability, hardening, deploy
- Dashboard, audit view, optional `/metrics`.
- Security review (see `/security-review`), pen-test the auth/CSRF/rate-limit paths.
- Compose + nginx + CI/CD (§10); docs + runbook; update the wiki.

### Phase 6 (recommended, parallelizable) — Session Manager hardening (§11)
- Rate limiting, timing-safe key compare, optional audit hooks. Can ship independently.

---

## 9A. Detailed task breakdown (tasks, gates & verification)

Each phase below lists granular **tasks**, an exit **Gate** (binary — all must hold to advance),
and **Verify** steps (how to prove it). A phase is not "done" until its gate passes in CI on a PR.

### Definition of Done (applies to *every* phase)
- `npm run lint` and typecheck clean across changed workspaces; `npm run format` applied.
- `npm run test:unit` and (where applicable) `npm run test:integration` green in CI.
- A `.changeset/` entry added for each changed workspace (repo uses changesets — see `RELEASING.md`).
- PR reviewed; no secret (`ADMIN_API_KEY`, `ADMIN_LOCAL_CREDENTIALS`, `ADMIN_SESSION_SECRET`) appears
  in any committed file or in a built browser bundle.
- Docs/runbook updated for anything an operator must configure.

---

### Phase 0 — Decisions & scaffolding

**Tasks**
- [ ] Close remaining Open Decisions (§13 #2–#6): BFF vs nginx-gate, proxy vs task endpoints, roles,
      audit storage, whether §11 hardening is in-scope. Record the calls at the top of this file.
- [ ] Create workspace `apps/admin-webapp` by copying `client-webapp` (Dockerfile, `vite.config.ts`,
      `tsconfig.json`, `eslint.config.js`, `src/{main,app,components,store,config,env.d,types,features/url-config}`).
      Rename package `@scribear/admin-webapp`; dev `server.port` 3003; keep the `/api/session-manager`→
      remove it, add `/api/admin` proxy target for local dev.
- [ ] Create workspace `apps/admin-server` by copying the structure of `apps/session-manager`
      (app-config, `create-server`, DI, probes feature, tests scaffolding, Dockerfile, esbuild config).
      Package `@scribear/admin-server`; strip session-manager's domain features.
- [ ] Add both to root workspaces; add `tsconfig` project references; add `@scribear/session-manager-client`
      + `@scribear/session-manager-schema` deps to `admin-server`; extend `detect-changes` mapping.
- [ ] Both apps expose a working `/healthcheck` (webapp) / `probes/liveness` (server) and build.

**Gate**
- Both new workspaces install, build, lint, and typecheck from a clean `npm install` at the repo root.
- `admin-webapp` serves a placeholder page; `admin-server` boots and answers its liveness probe.
- CI's change-detection recognizes the new workspaces.

**Verify**
- `npm install && npm run build` at root succeeds including both new packages.
- `npm run dev --workspace @scribear/admin-server` → `curl localhost:<port>/api/admin/v1/probes/liveness` returns `{status:"ok"}` (path prefix TBD in Phase 1).
- `npm run dev --workspace @scribear/admin-webapp` → placeholder loads in a browser.
- `npm run lint && npm run test:unit` green.

---

### Phase 1 — BFF core (auth, session, proxy, observability)

**Tasks**
- [ ] Define `admin-server` app-config schema (env → typed config): `ADMIN_API_KEY`,
      `SESSION_MANAGER_BASE_URL`, `ADMIN_SESSION_SECRET`, `ADMIN_LOCAL_CREDENTIALS`,
      `ADMIN_RATE_LIMIT_*`, and *optional* `AZURE_*` (unused now). Fail fast if required ones missing.
- [ ] **Auth layer (§4.4):** `AuthProvider` interface + `Identity` type; `LocalAuthProvider`
      (parse `ADMIN_LOCAL_CREDENTIALS` split on first space; `crypto.timingSafeEqual` on username+password;
      disabled when env empty). Stub `AzureOidcProvider` (interface only).
- [ ] Session machinery: signed HttpOnly+Secure+SameSite=Strict cookie via `@fastify/cookie`/session;
      `requireSession` hook guarding `/api/admin/*`; `/auth/login`, `/auth/logout`, `/auth/config`,
      (future) `/auth/sso/*` route stubs. CSRF protection (double-submit token) on state-changing routes.
- [ ] Register `@fastify/rate-limit`: strict on `/auth/login`, moderate on mutations.
- [ ] Session Manager gateway: construct `createSessionManagerClient(SESSION_MANAGER_BASE_URL)`; a helper
      that injects `Authorization: Bearer ${ADMIN_API_KEY}` on every call; consistent response envelope
      `{ ok, data?, error?:{code,message,requestId} }`; map upstream 401 → "backend misconfig", 4xx → passthrough.
- [ ] First proxy/task endpoints: **rooms** (list/get/create/update/delete + membership/source) and
      **devices** (list/get/register/reregister/update/delete). Validate bodies with shared schemas.
- [ ] `/api/admin/health` rollup (BFF up? session-manager reachable? readiness?). Structured logging with
      upstream status+latency and request-id propagation. Audit-log store + write on every mutation.

**Gate**
- Unauthenticated request to any `/api/admin/*` (non-auth) route → 401; no upstream call made.
- Valid local login issues a session cookie; wrong password → 401 and is rate-limited after N tries.
- With `ADMIN_LOCAL_CREDENTIALS` empty, `/auth/config` reports `{local:false}` and `/auth/login` 404/disabled.
- Admin key is present **only** server-side; it never appears in any response body or log line.
- Every mutation writes an audit record; CSRF-less state-changing request is rejected.

**Verify**
- Integration tests (Vitest, mirror `session-manager/tests/integration`) with session-manager **mocked**:
  login success/failure, session guard, CSRF reject, rate-limit lockout, envelope mapping, key injection
  (assert the outgoing `Authorization` header), audit write.
- Manual: `curl` login → capture cookie → call `list-rooms` (200) → call without cookie (401) →
  hammer `/auth/login` to trip the limiter (429).
- `grep -r` the built `admin-server` bundle/logs in a test run to confirm no credential leakage.
- `npm run test:unit && npm run test:integration --workspace @scribear/admin-server` green.

---

### Phase 2 — SPA core + rooms & devices UI

**Tasks**
- [ ] App shell: introduce `react-router`; layout + nav; `RequireAuth` guard that redirects to `/login`
      when `/auth/config`+session say unauthenticated; theme via `AppThemeProvider`; global error boundary;
      snackbar/toast host. Data layer via the **service+middleware** idiom started on `appInitialization`.
- [ ] Login page: reads `/auth/config`, renders password form (local) and/or SSO button (hidden until Azure).
- [ ] Rooms: list (server search + cursor "Load more"), detail (devices w/ source badge, schedules,
      auto-windows, sessions), create, rename, delete (confirm dialog), add/remove device, set source.
- [ ] Devices: list (filter active/room/search), detail, register (activation-code display + expiry
      countdown), rename, re-register (confirm), delete.
- [ ] Error/success/conflict UX (§6.4): toasts on success; 422→inline field errors; 409→human guidance
      (source-delete, membership orphan); 401→login redirect; backend-misconfig banner distinct from login.

**Gate**
- An operator can, from the browser, complete every rooms + devices CRUD path end-to-end against a real
  BFF+session-manager, including the conflict paths (delete-source-device 409, remove-source 409).
- No admin key or credential is present anywhere in the shipped JS bundle.
- Session expiry mid-use routes the user cleanly to `/login` without a crash.

**Verify**
- Component/interaction tests (Vitest + Testing Library) for wizardless forms, list pagination, and the
  three error classes (422/409/401) rendering correctly.
- Manual E2E against `deployment/compose.yml` (session-manager + Postgres): register device → create room
  with it as source → rename → add second device → set source → try to delete source (expect blocked) →
  delete room.
- Run the `/verify` skill on the rooms+devices flow (drive the real UI, observe behavior).
- `grep` production bundle for `ADMIN_API_KEY`/`Bearer ` → no hits.

---

### Phase 3 — Kiosk setup wizard

**Tasks**
- [ ] Multi-step wizard (§6.3): (1) name → `register-device`, show activation code big/copyable + expiry
      countdown + instructions; (2) new room as source **or** existing room + `add-device-to-room`/`set-source-device`;
      (3) optional schedule/auto-session; (4) verify by polling `get-device/:uid` until `active=true`.
- [ ] Optional BFF aggregate endpoint `POST /api/admin/provision-kiosk` (register + assign in one call,
      audited as one action) if Open Decision #3 chose task endpoints.
- [ ] Handle re-entrancy: expired activation code → offer `reregister-device`; back/forward without orphaning.

**Gate**
- A brand-new device can be taken from "nothing" to "activated kiosk assigned as a room source" entirely
  in the wizard, with the activation confirmation observed live.

**Verify**
- E2E: run the wizard; in a second browser open `/kiosk`, enter the shown code (simulating the kiosk's
  `activate-device`); confirm the wizard's poll flips to "activated ✓" and the device shows `active=true`,
  correct `roomUid`, `isSource=true`.
- Negative: let the activation code expire → wizard offers re-register and recovers.
- `/verify` skill on the full wizard path.

---

### Phase 4 — Schedules & sessions

**Tasks**
- [ ] Schedule CRUD UI: tz-aware time pickers (room tz shown explicitly), day-of-week multiselect,
      frequency (ONCE/WEEKLY/BIWEEKLY), join-code scopes, transcription provider/config. Client-validate
      against shared schemas before submit.
- [ ] Auto-session-window CRUD UI; room auto-session master toggle (`update-room-schedule-config`).
- [ ] Session ops: create on-demand session; start-early; end-early; session detail view.
- [ ] Surface domain conflicts: session overlap (409), invalid override times (422), start/end-early 409/422.

**Gate**
- All schedule/auto-window/session operations succeed for valid input and show correct, specific errors
  for the constrained cases (overlap, override ordering, non-empty days for WEEKLY/BIWEEKLY).

**Verify**
- Integration + component tests covering DST boundaries and midnight-wrap windows (end < start).
- E2E: create a weekly schedule → confirm a materialized session appears via `list-schedules`/`get-session`;
  create an overlapping on-demand session → expect 409 rendered clearly; start-early then end-early a session.
- `/verify` skill on the schedule editor and session-ops paths.

---

### Phase 5 — Observability, hardening, deploy

**Tasks**
- [ ] Dashboard (health tiles from BFF `/health`, counts, expiring activation codes, recent audit actions,
      quick actions); `/audit` view; optional BFF `/metrics`.
- [ ] nginx: add `/admin/` and `/api/admin/` locations + upstreams (§10.1). Compose: add `admin-webapp`
      and `admin-server` services + env + `depends_on` (§10.2). `deployment/.env.example` env additions (§10.4).
- [ ] Dockerfiles for both apps (webapp→nginx-alpine SPA; server→Node runtime). Extend `node-ci`/`node-cd`
      + `detect-changes` to build/test/publish both to GHCR.
- [ ] Tighten CSP/HSTS for the admin origin; final secrets review.
- [ ] **Wiki documentation (§10A):** create `Admin-Website.md`, `Developing-Admin.md`,
      `Admin-Runbook.md`; edit `Home.md`, `Deployment.md`, `Documentation`, `_Sidebar.md`; update repo
      `README.md` layout/index. Must satisfy the §10A.7 documentation gate.
- [ ] Run `/security-review` on the branch and resolve findings.

**Gate**
- The full stack (incl. the two new services) comes up healthy via `docker compose up`; the admin site is
  reachable at `/admin/` over HTTPS, authenticates, and performs a full rooms/devices/kiosk/schedule flow.
- `/security-review` findings triaged/closed; no secret in any image layer or browser bundle;
  CSRF, rate-limit, session-expiry, and role checks pass a manual pen-pass.
- CI builds and publishes both images on merge to `staging`.

**Verify**
- `docker compose -f deployment/compose.yml up` → all services `healthy`; nginx `depends_on` satisfied.
- Browser: hit `https://<host>/admin/`, log in with the local account, run one operation from each feature.
- Security pass: attempt cross-site state change (CSRF blocked), reuse expired session (redirected),
  brute-force login (rate-limited), inspect image with `docker history`/layer grep for secrets (none).
- `/security-review` clean; smoke E2E green in CI against an ephemeral compose stack.

---

### Phase 6 — Session Manager hardening (parallel, independent PRs)

**Tasks**
- [ ] Add `@fastify/rate-limit` in `libs/base-fastify-server` (or per-service); throttle `exchange-join-code`,
      `refresh-session-token`, and admin/service key routes.
- [ ] Replace `key === …` with `crypto.timingSafeEqual` in `admin-auth.service.ts` + `service-auth.service.ts`;
      enforce a minimum key length / reject `CHANGEME`.
- [ ] (Optional) multi-key/identity map + audit hook; (optional) `lastSeenAt` + count/metrics endpoints (§11.4).

**Gate**
- Existing session-manager unit + integration suites stay green; new tests cover rate-limit and
  timing-safe behavior; no change to the wire contract the BFF depends on (or a coordinated bump).

**Verify**
- `npm run test:unit && npm run test:integration --workspace @scribear/session-manager` green.
- Load a burst at `exchange-join-code` → observe 429s; confirm valid flows unaffected.
- Contract check: the admin-server integration suite still passes against the hardened session-manager.

---

## 10. Deployment & delivery

### 10.1 nginx (`infra/scribear-nginx/nginx.conf`)
Add two locations inside the `:443` server:
```nginx
location /admin/ {
    proxy_pass http://admin-webapp/;      # static SPA (try_files fallback in its image)
    # standard proxy_set_header block as elsewhere
}
location /api/admin/ {
    proxy_pass http://admin-server;       # BFF
    # standard proxy_set_header block; no key here — the BFF holds it
}
```
Add `upstream admin-webapp { server admin-webapp:80; }` and
`upstream admin-server { server admin-server:80; }`.

### 10.2 Compose (`deployment/compose.yml`)
Add `admin-webapp` (frontend network) and `admin-server` (both networks; env
`ADMIN_API_KEY=${SESSION_MANAGER_API_KEY}`, `SESSION_MANAGER_BASE_URL=http://session-manager:80`,
staff-auth/OIDC config, session-cookie secret, DB creds if audit/local-accounts use Postgres).
`admin-server` depends on `session-manager` (and `scribear-db` if it persists audit/accounts).
Add nginx `depends_on` for both new services.

### 10.3 Images & CI/CD
- Dockerfiles: `admin-webapp` mirrors `client-webapp` (multi-stage → nginx-alpine, SPA fallback,
  `/healthcheck`). `admin-server` mirrors `session-manager`'s Dockerfile (Node runtime).
- Extend `.github/workflows/node-ci.yml` / `node-cd.yml` and `detect-changes` to build/test/publish
  both new workspaces to GHCR alongside the rest.

### 10.4 Env additions (document in `deployment/.env.example`)
- `ADMIN_API_KEY=${SESSION_MANAGER_API_KEY}` — reused; held only by `admin-server`.
- `ADMIN_SESSION_SECRET` — signs the session cookie (strong random).
- `ADMIN_LOCAL_CREDENTIALS` — `"<username> <password>"` for the local account (e.g.
  `"engrit hag3hasdgqwy!"`); **empty/unset disables local login**.
- `ADMIN_RATE_LIMIT_*` — login + action throttles.
- *(future, unset for now)* `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_REDIRECT_URI`, `ADMIN_ALLOWED_GROUP` — presence enables the Azure SSO provider.

---

## 10A. GitHub wiki documentation additions (user-facing & devops)

The project's user-facing docs live in the **companion wiki**, not in-repo. Per the README, the
wiki is the *authoritative* reference for API shapes, protocols, config, and deployment. The admin
website must be documented there for two audiences: **IT operators** (how to use it and deploy it)
and **developers** (how it's built and how to add Azure SSO). This work is part of **Phase 5** and
its gate: docs merged before the feature is announced.

### 10A.0 How to edit the wiki
- The wiki is a **separate git repo**: `https://github.com/scribear/scribear.wiki.git`
  (clone it alongside the code repo; it is *not* a folder in `scribear/scribear`).
- Pages are Markdown files at the repo root; **filename = page title with spaces → hyphens**
  (e.g. page "Admin Website" → `Admin-Website.md`). Links use the page title:
  `[Admin Website](Admin-Website)`.
- The left nav is `_Sidebar.md`; a shared footer is `_Footer.md`. New pages must be added to
  `_Sidebar.md` or they're only reachable by direct URL.
- Keep the existing tone: short "start here by audience" framing, code-fenced config snippets,
  and cross-links to sibling pages. Mirror any config/env you document against
  `deployment/.env.example` and `deployment/compose.yml` so the two never drift.

### 10A.1 NEW page — `Admin-Website.md` (IT operator guide)
Primary user-facing page. Outline:
1. **What it is / who it's for** — a web console for IT to manage rooms, devices, kiosks,
   schedules, and sessions; replaces the `deployment/*.sh` curl scripts.
2. **Accessing it** — URL `https://<host>/admin/`; supported browsers; that it must be reached
   over HTTPS.
3. **Signing in** — local account today (username/password from `ADMIN_LOCAL_CREDENTIALS`); note
   that **Azure AD SSO is planned** and the login page will show a "Sign in with Illinois" button
   once enabled. Call out the **shared-account caveat**: with the local account, every action is
   audited as the same user — per-person attribution arrives with SSO.
4. **Core tasks** (each a short numbered walkthrough with a screenshot placeholder):
   Create a room · List/search rooms & devices · Rename/delete · Add/remove a device from a room ·
   Set a room's source device · **Set up a kiosk** (the wizard: register → show activation code →
   assign to room → confirm activation) · Create/edit a schedule & auto-sessions · Create an
   on-demand session · Start/end a session early.
5. **Reading status & errors** — health tiles, success toasts, what 409/422 messages mean
   (e.g. "can't delete a device that is a room's source"), the "backend misconfiguration" banner.
6. **What's not shown yet** — device online/offline and historical metrics aren't available yet
   (link to the enhancement note in Deployment).
7. **Troubleshooting** — can't log in, activation code expired (re-register), session expired.
8. Cross-links to **Deployment** (for admins who also operate the stack) and **Developing Admin**.

### 10A.2 NEW page — `Developing-Admin.md` (developer guide, sibling of "Developing Session Manager")
1. **Architecture** — BFF (`apps/admin-server`) + SPA (`apps/admin-webapp`); why the BFF exists
   (admin key stays server-side; §3/§4 of this plan). Small ASCII diagram.
2. **Local dev** — `npm run dev` for each workspace, dev ports (webapp 3003), the `/api/admin`
   Vite proxy, running against a local session-manager + Postgres.
3. **Auth provider layer (§4.4)** — the `AuthProvider`/`Identity` interface; how `LocalAuthProvider`
   reads `ADMIN_LOCAL_CREDENTIALS`; **"Adding the Azure Entra ID provider"** step-by-step (register
   an app in Entra, set `AZURE_*`, implement `verify()`, group allowlist) — the seams are already in.
4. **BFF API surface** — the `/api/admin/*` routes and the `{ ok, data?, error? }` envelope; link to
   10A.3.
5. **Conventions** — service+middleware idiom, typed redux hooks, shared TypeBox schemas, testing
   (Vitest unit/integration), changesets.

### 10A.3 NEW section on the existing `Documentation` page — "Admin BFF API"
- State that admin operations go through the **BFF** (`/api/admin/*`), which fronts the
  admin-guarded Session Manager routes; the browser never holds `ADMIN_API_KEY`.
- Document the BFF envelope, the auth routes (`/auth/login`, `/auth/logout`, `/auth/config`,
  future `/auth/sso/*`), CSRF-token handling, and the `/api/admin/health` rollup.
- Cross-reference (don't duplicate) the Session Manager admin endpoints already listed there.

### 10A.4 EDITS to existing pages
- **`Home.md`** — add `admin-webapp` and `admin-server` to the architecture overview / component
  list and the request-flow description (browser → nginx `/admin/` & `/api/admin/` → BFF →
  session-manager). Add both to any diagram.
- **`Deployment.md`** — add the full **"Admin website"** devops subsection (10A.5 below).
- **`_Sidebar.md`** — add links to **Admin Website** and **Developing Admin** under the right groups
  (operator page near Deployment; dev page in the "Developing …" list).
- **Repo `README.md`** (not wiki, but do it in the same PR) — add `apps/admin-webapp/` and
  `apps/admin-server/` to the "Repo layout" map and the wiki index list.

### 10A.5 Deployment-page content (devops / deployment config — the important bit)
Add a self-contained "Admin website" subsection to `Deployment.md` containing:

- **Services** — `admin-webapp` (static SPA, nginx-alpine, `frontend` network) and `admin-server`
  (BFF, both networks). Paste the `compose.yml` service blocks (mirroring §10.2) and the nginx
  `/admin/` + `/api/admin/` locations + upstreams (§10.1).
- **Environment variables** — a table an operator can act on:

  | Var | Required | Meaning |
  |---|---|---|
  | `ADMIN_API_KEY` | yes | Session Manager admin key; set on `admin-server` only (reuse `SESSION_MANAGER_API_KEY`). Never on a webapp. |
  | `ADMIN_SESSION_SECRET` | yes | Signs the admin session cookie; long random string; rotating it logs everyone out. |
  | `ADMIN_LOCAL_CREDENTIALS` | today | `"<username> <password>"` (split on first space). **Empty/unset disables local login.** |
  | `ADMIN_RATE_LIMIT_*` | opt | Login/action throttles. |
  | `AZURE_TENANT_ID`/`CLIENT_ID`/`CLIENT_SECRET`/`REDIRECT_URI`, `ADMIN_ALLOWED_GROUP` | future | Presence enables Azure SSO; unset = SSO off. |

- **TLS / exposure** — must be behind the same HTTPS nginx; recommend restricting `/admin/` and
  `/api/admin/` to the campus network/VPN or an IP allowlist since it's high-privilege.
- **First login** — set `ADMIN_LOCAL_CREDENTIALS`, `docker compose up`, browse `https://<host>/admin/`,
  sign in.
- **Rotating the local credential** — change the env var and restart `admin-server`; note it
  invalidates the current login.
- **Going SSO-only later** — set the `AZURE_*` vars, **clear `ADMIN_LOCAL_CREDENTIALS`**, restart;
  the login page switches to the SSO button automatically (no rebuild).
- **Security notes** — admin key is server-side only; shared-account audit caveat; rate limiting is
  on the BFF; keep the two new images updated with the rest of the stack (same `IMAGE_TAG`).
- **Enhancement note** — device online/offline & historical metrics require the §11.4 backend work.

### 10A.6 NEW page (or Deployment appendix) — `Admin-Runbook.md` (operator runbook)
Step-by-step for recurring ops, each as a copy-followable checklist: **provision a new kiosk**,
**decommission a device** (reassign source first, then delete), **create a room + schedule for a
new space**, **rotate the admin login**, **respond to "backend misconfiguration" banner** (check
`ADMIN_API_KEY` matches session-manager), **check stack health** (`/api/admin/health`, probes).

### 10A.7 Documentation gate (rolls into Phase 5)
- [ ] `Admin-Website.md`, `Developing-Admin.md` created; `Home.md`, `Deployment.md`, `Documentation`,
      `_Sidebar.md` edited; repo `README.md` layout/index updated in the same feature PR.
- [ ] Every env var, compose block, and nginx snippet in the wiki **matches** `deployment/.env.example`,
      `deployment/compose.yml`, and `infra/scribear-nginx/nginx.conf` verbatim (no drift).
- [ ] A reviewer who has never seen the app can deploy it and set up a kiosk using only the wiki.
- [ ] No secret values (only placeholders like `CHANGEME`) appear in any wiki page.

---

## 11. Recommended Session Manager hardening (independent PRs)
1. **Rate limiting** (`@fastify/rate-limit`) — especially the unauthenticated `exchange-join-code`
   / `refresh-session-token`, and the admin key. (`create-base-server.ts` currently registers none.)
2. **Timing-safe** admin/service key comparison (`crypto.timingSafeEqual`), matching the
   session-token path; enforce a minimum key length / reject `CHANGEME`.
3. **Optional multi-key / audit hooks** — allow several named admin keys (map key→identity) so the
   BFF can pass a per-operator key, giving Session Manager-side attribution. Lower priority if the
   BFF owns identity+audit.
4. **Status/perf surface (enables richer UI)** — none of "device online/offline", "active sessions
   now", or historical metrics exist today. If IT wants them, add e.g. a device `lastSeenAt`
   (updated on `my-schedule` poll / token exchange) and lightweight count/metrics endpoints.
   Until then the admin UI must not fabricate these.
5. Consider a tightened CSP/HSTS via helmet options for the whole stack.

---

## 12. Testing strategy
- **BFF unit/integration** (Vitest, mirror `session-manager/tests`): auth, CSRF, rate limiting,
  key injection, error-envelope mapping, audit writes; upstream calls mocked.
- **SPA**: component/interaction tests for wizard, forms, error/conflict rendering; typed against
  shared schemas.
- **E2E**: against a compose stack with a real session-manager + Postgres — full flows: register
  device → activate (simulate kiosk) → create room → set source → schedule → start/end session →
  delete. Include negative paths (409 source-delete, overlap, expired activation code, expired session).
- **Security**: run `/security-review`; verify no key leaks to the browser; test session expiry,
  CSRF rejection, rate-limit lockout, authz on read-only vs read-write roles.

---

## 13. Open decisions (need a call before Phase 1)
1. ~~**Staff authentication**~~ **DECIDED** (§4.4): pluggable auth — local env-account
   (`ADMIN_LOCAL_CREDENTIALS`) now, Azure Entra ID SSO added later behind the same interface.
2. **Architecture**: full BFF (§4.1, recommended) vs interim nginx-gate + header injection (§4.2).
3. **BFF API shape**: thin 1:1 proxy vs task-oriented endpoints (e.g. one "provision kiosk" call).
   *Recommendation: mostly 1:1, plus a few aggregate endpoints (room detail, provision kiosk).*
4. **Roles**: single admin role vs read-only + read-write split for launch.
5. **Audit/local-account storage**: reuse `scribear-db` (new migration) vs a separate store vs
   logs-only for launch.
6. **Do we bundle §11 hardening** into this effort or track it separately?

## 14. Risks
- Static-key model means a BFF compromise = full admin power → invest in BFF auth/audit/rate-limit.
- No CORS/rate-limit upstream → the BFF must be the enforcement point.
- Timezone/recurrence correctness in schedule editors is fiddly — lean on the shared schemas and
  the server's validation; test around DST and midnight-wrap windows.
- Introducing `react-router` and a first BFF service adds surface the repo hasn't carried before —
  keep them conventional and well-tested.

## 15. Rough effort (engineering, very approximate)
- Phase 0–1 (scaffold + BFF core + rooms/devices proxy): ~1.5–2.5 wks
- Phase 2 (SPA shell + rooms/devices UI): ~2–3 wks
- Phase 3 (kiosk wizard): ~0.5–1 wk
- Phase 4 (schedules/sessions): ~1.5–2.5 wks
- Phase 5 (observability/hardening/deploy/docs): ~1–1.5 wks
- Phase 6 (session-manager hardening, parallel): ~0.5–1 wk

---

### Appendix A — key files reviewed
- API/routers: `apps/session-manager/src/server/features/*/*.router.ts`
- Auth: `apps/session-manager/src/server/hooks/*.hook.ts`, `.../shared/services/admin-auth.service.ts`, `libs/schemas/session-manager-schema/src/shared/security/admin-api-key.ts`
- Server/base: `apps/session-manager/src/server/create-server.ts`, `libs/base-fastify-server/src/server/create-base-server.ts`
- Schemas/base path: `libs/schemas/session-manager-schema/src/{base-path.ts,metadata.ts,*/entities,*/routes}`
- Client lib: `libs/clients/session-manager-client/src/*`
- Domain/migrations: `infra/scribear-db/src/migrations/*`
- Kiosk flow: `apps/kiosk-webapp/src/features/kiosk-provider/*`
- Frontend template: `apps/client-webapp/*`
- Deploy: `deployment/{compose.yml,.env.example,create-room.sh,register-device.sh}`, `infra/scribear-nginx/nginx.conf`
