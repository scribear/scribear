# @scribear/scribear-nginx

## 0.3.0

### Minor Changes

- 0e7ec83: Stop the public reverse proxy from forwarding two routes their own schemas
  describe as cluster-internal.

  `GET /api/node-server/v1/status` is documented in
  `libs/schemas/node-server-schema/src/status/routes/status.schema.ts` as
  "intended for internal observability consumers (Monitoring Sidecar, Admin
  Server) on the cluster-internal network; it must not be exposed through the
  public reverse proxy", and the same sentence is restated in the schema's tag
  description, in two CHANGELOGs, and in the sidecar's operator-facing alert text
  ("check it is reachable on the internal network (it must not be exposed through
  nginx)"). Nothing enforced it. `location /api/node-server/` forwards the whole
  prefix, so the endpoint answered 200 through the public origin with the service
  key and 401 without it — an internal telemetry surface carrying session uids,
  room uids and per-process counters, on the internet behind one shared static
  secret. Verified against a running stack before the fix, both status codes.

  `GET /api/session-manager/v1/schedule-management/session-config-stream/:sessionUid`
  is the same shape of mistake with quieter wording: it is guarded by the _service_
  key rather than the admin key or a device token, and that key's schema says it is
  "used by sibling services (Session Stream Server) to consume internal APIs". It
  too sat on a publicly forwarded prefix.

  Both are now shadowed by `location ^~ ...` blocks that `return 404`. Nothing
  breaks: every real consumer reaches its service directly over the `backend`
  compose network — the sidecar and admin-server via
  `NODE_SERVER_BASE_URL=http://node-server:80`, node-server via
  `SESSION_MANAGER_BASE_URL=http://session-manager:80` — so none of them traverse
  nginx at all. Nothing in the repo, tests and `tools/` scripts included, fetches
  either path through an nginx origin.

  404 rather than `deny all`'s 403, because a 403 confirms the route exists and
  merely withholds it, which is the one fact an unauthenticated prober is after;
  and rather than 401, which would invite key guessing. Prefix matches rather than
  exact ones, so a trailing slash or a future sub-path (`/status/sessions`) does
  not quietly become public again.

  Rejected: leaving both to their service API keys, as before — one static
  unrotated key with no rate limit is a thin last line, and the schema does not
  say "exposed but authenticated". Rejected: `allow`/`deny` on the compose subnets
  — internal callers never traverse nginx, so the allowlist would match nobody and
  would break whenever compose renumbered. Rejected: moving the routes off the
  `/api/...` prefixes onto a separate port or an `/internal/` base path, which is
  the more robust fix but changes the schema contract every generated client
  derives its URLs from, and is not a decision the proxy config gets to make.

  Left alone deliberately: `/api/session-manager/v1/database/schema`, whose schema
  already reasons explicitly about sitting on a public prefix and uses the admin
  key as the control; the unauthenticated `probes/*` routes, which container
  orchestration needs; and every monitoring-sidecar and transcription-service
  route, which have no nginx upstream at all and so were never reachable.

- f5a6a37: The site root now opens the client webapp instead of 404ing.

  `nginx.conf` routed `/client/`, `/kiosk/`, `/standalone/`, `/admin/`,
  `/grafana/` and the `/api/...` prefixes, and nothing at all at `/` — there is no
  `location /` in the TLS server, so the bare hostname returned nginx's own 404.
  That is the URL a person types by hand into a lecture-room browser, and it was
  the one URL in the deployment that led nowhere.

  `location = /` now returns a 302: to `/client/` for an onsite visitor, and to
  `/extlanding` for a gated one — the same landing page every other frontend
  surface already redirects to, so the onsite gate's behavior for an outside
  visitor is unchanged. Exact match, so `/` alone is affected and every other
  unrouted path still 404s.

  **302, not 301/308.** What `/` resolves to depends on which network the visitor
  is on, so a permanent redirect would be cached by the browser and replayed for
  the same person after they leave campus — exactly the distinction this location
  exists to make.

  **`Cache-Control: no-store` as a literal, not the `$onsite_no_cache` map.** The
  map is empty on the allowed path because the gated locations _proxy_ there, and
  an upstream's own `Cache-Control` on hash-versioned assets must be left alone.
  Here both branches are IP-dependent redirects, so neither may be stored.

  **`absolute_redirect off`, on the whole TLS server.** nginx expands a redirect
  written as a path into an absolute URL built from `$host`, which carries no
  port: on the dev/iso stack published at `:8443` the browser was sent to
  `https://<host>/client/` on port 443 — a different stack on the same machine.
  Observed against a real container, not theorised. This was found while adding
  the root redirect but affects every redirect nginx generates here, so the
  directive sits on the server: the `/client` and `/grafana` trailing-slash 308s
  and all seven of the onsite gate's `/extlanding` 302s now stay on the origin the
  client actually reached. Production, served on 443, is byte-identical either
  way — which is exactly why this could not be caught there, and why
  `tests/unit/relative-redirects.test.ts` now pins both the directive and the
  path-style targets it governs.

  Untouched: the plain-HTTP listener's `return 301 https://$host$request_uri`,
  which is an absolute URL by construction and could not be fixed here anyway —
  it crosses schemes, and the TLS port is not derivable from the HTTP one. And
  upstream-generated `Location` headers, which are `proxy_redirect`'s business;
  no location sets one.

  Verified end-to-end against `ghcr.io/scribear/scribear-nginx` with the shipped
  config and both a permissive and a `default 0` allowlist: onsite `/` → 302
  `/client/` (relative, port preserved) → 200 from the client webapp; gated `/` →
  302 `/extlanding` with `X-Onsite-Gate: denied` → 200 landing page; every one of
  `/`, `/client`, `/grafana`, `/client/`, `/kiosk/`, `/standalone/`, `/admin/` and
  `/grafana/` emitting a bare-path `Location` on both sides of the gate;
  `/healthz` 200, an unrouted path 404, and an API still 403 off-campus.
  `onsite-gate.test.ts`
  now covers the root as an eleventh gated location — including the two ways it
  legitimately differs from the others (no `proxy_pass` to run ahead of, and the
  literal `no-store`), so neither can be quietly dropped.

### Patch Changes

- 6f61774: Demo caption room: on by default everywhere, surfaced in the admin console with
  a one-click "open live captions" link, with a bare-`/client` routing fix.
  - **On by default.** `DEMO_ROOM_ENABLED` now defaults to `true` in both the Node
    Server and Session Manager (every environment, including production); set
    `DEMO_ROOM_ENABLED=false` to turn it off. `DEMO_SESSION_UID` is no longer
    plumbed through `deployment/compose.yml` — both services share the same
    built-in default, so neither var needs setting for a working demo room.
  - **Admin dashboard — Demo caption room card.** Shows whether the demo room is
    enabled and whether its seeded session is currently joinable, and — when it is
    — an **Open live captions** button that opens the client webapp straight into
    the looping demo captions with no manual join-code entry. A forcing function
    for exercising the client frontend end-to-end without a mic, source device, or
    transcription service.
  - **Session Manager — `GET /demo-room/status` (admin-key).** Reports
    `{ enabled, sessionUid, active, roomName, joinCode }`, minting/returning a
    currently-valid join code (via the same idempotent `ensureCurrentJoinCode` the
    seeder uses) only when the session is active. Plumbed through the
    session-manager schema + client and proxied by the admin server's gateway with
    the admin API key it already holds; the console builds the same-origin
    `/client/#config=<base64>` deep link the kiosk QR uses.
  - **nginx — route bare `/client`.** A request to `/client` (no trailing slash)
    now 308-redirects to `/client/` (the browser preserves the `#config=...`
    fragment), so deep links resolve regardless of the trailing slash.
  - **Kiosk — fix QR 404.** The QR code defaulted to `${origin}/client` (no
    trailing slash); the reverse proxy only serves `/client/`, so scanned codes
    404'd. Now defaults to `${origin}/client/`.

- 64a2a70: Default the standalone audio meter's peak zones to -12 / -3 dBFS.

  The zone boundaries are applied to the held sample peak, but the defaults were
  taken from EBU alignment level, which is an RMS convention. A sine at -18 dBFS
  RMS peaks at -15.01 dBFS — 3 dB above the old warn boundary — so a correctly
  levelled, perfectly healthy speech signal rendered amber. For a lecture-room
  speech meter the boundary exists to guard headroom, which peak defines, so the
  "speech headroom" preset already present in the meter's own zone selector is
  the right default. Both alignment presets remain selectable.

  nginx's pinned CSP hashes cover the meter page's inline scripts and were
  recomputed to match.

  The admin dashboard's `rmsDbfsHigh` (-6 dBFS) is deliberately unchanged: it is
  an RMS threshold in a different system, and only its comment claimed parity
  with the meter's peak default.

- dc104ab: Deployment Check now shows what each container was built from, so an operator
  can confirm what is actually deployed and running.
  - **Every image is stamped at build time.** `BUILD_COMMIT`, `BUILD_REF`,
    `BUILD_TIME`, `BUILD_VERSION`, `BUILD_TAGS`, `BUILD_PR` and `BUILD_ORIGIN`
    become `SCRIBEAR_BUILD_*` environment variables and OCI image labels
    (`org.opencontainers.image.revision`/`.version`/`.created`, plus
    `org.scribear.build.pull-request`/`.origin`), so `docker inspect` answers the
    same question as the console. The block sits last in every Dockerfile, so
    changing commit invalidates no expensive layer.
  - **Every container reports it.** The four Node services answer
    `GET /build-info` from a route `createBaseServer` registers for them;
    transcription-service answers the same path from FastAPI; the four webapps and
    the reverse proxy serve an identical `build-info.json` generated at image
    build time by `tools/build-info/write-build-info.sh`. All of these are
    reachable only inside the compose network — nginx proxies none of them, and
    the proxy's own document is served on its plain-HTTP listener only, so no
    commit hash is published to the internet.
  - **Admin console — Deployment Check → Deployed versions.**
    `GET /api/admin/v1/deployment-versions` probes every container concurrently
    and renders a table of version, commit, branch, build time and image tags.
    Version skew is the headline: the commit the most containers report is taken
    as the deployment's, and any container that disagrees is named in a warning.
    This is the only place in the console that can see a half-finished upgrade —
    a stale container is a perfectly healthy container, so the health rollup stays
    green throughout.
  - **Old and local builds are distinguished, not blanked.** A container running
    an image from before this release answers 404 and is reported as
    `old image` rather than as unreachable — it is stale, not down.
    `build-containers.sh` stamps the real commit for local builds, marks them
    `origin: local`, and appends `-dirty` when the working tree has uncommitted
    changes; a stack started straight from a checkout (`npm run dev`) reports
    "nothing here was built by CI" instead of a table of blanks.
  - **`scribear-db` and `redis`** appear in the table as `n/a` with the reason:
    neither has an HTTP surface to report a build on.
  - **PR images are published again, named for their target environment.** A
    pull request into `staging` pushes
    `ghcr.io/scribear/<image>:staging-pr<n>`; into `main`,
    `ghcr.io/scribear/<image>:production-pr<n>` — so a reviewer can pull the
    exact build under review rather than rebuilding it, and tell at a glance
    which environment it's a candidate for, without cross-referencing the PR
    on GitHub. The tag moves with the PR head. Set the repository variable
    `PUBLISH_PR_IMAGES` to `false` to switch it off, or `true` to publish for
    every base branch (tagged `<base-branch>-pr<n>`). Fork PRs still build
    without publishing, since their `GITHUB_TOKEN` cannot push.

  Nothing new is required in `deployment/.env`. The six new admin-server base-URL
  variables all default to their compose service names.

- 3a867f9: `upstream node-server` had no balancing directive, so nginx round-robined a
  service whose state is per-process.

  `TranscriptionOrchestratorService`'s own class doc asserts the opposite:
  "Sticky URL routing pins all connections for a given sessionUid to one Node
  Server instance, so the singleton state for a session is always co-located with
  the source connections feeding it." The event bus is in-process, and a session's
  upstream transcription connection lives on whichever instance its _source_
  reached. A viewer routed elsewhere subscribes to a channel nothing publishes on
  and receives no transcripts — no error, no close, no banner, just an empty
  caption view. `docker compose up -d --scale node-server=2` was one word away,
  and nothing about that word looks like it could break captioning.

  The upstream now hashes on `$node_server_session_uid`, a `map` over `$uri` that
  captures the session uid from the shared
  `/api/node-server/v1/transcription-stream/<sessionUid>/{source,client}` prefix —
  which is precisely why the route schema puts the uid in the path: "The session
  UID is carried in the URL so the L7 proxy can sticky-route every connection for
  a session to the same Node Server instance." `$uri` rather than `$request_uri`
  so a trailing query string or an encoded path segment cannot send a second
  connection for one session to a different peer.

  **`consistent` is deliberately absent, and that is a measurement, not a
  preference.** Ketama is the better algorithm here — a peer joining remaps ~1/N
  of sessions instead of most of them — but it is silently ignored when the
  upstream's server is a `resolve` name, which `node-server`'s is. Verified
  against `nginx:1.29.7-alpine3.23` (this image's base) with two backends behind
  one docker network alias, requesting one session uid repeatedly:

  ```
  hash $node_server_session_uid consistent;   ->  B A B A B A B A     (round-robin)
  hash $node_server_session_uid;              ->  B B B B B B B B
  ```

  `nginx -t` passes on both, and at one replica both behave identically — a
  `consistent` version of this fix would have merged green and done nothing. The
  final config was then re-verified verbatim from the repo: two uids held on two
  different peers across 12s and several `valid=5s` re-resolutions, with the
  WebSocket upgrade headers set, and `source` and `client` for the same uid always
  landing together. The cost of plain modulo hashing is that changing the replica
  count re-homes most sessions; that happens on a deploy, when every connection is
  being re-established anyway.

  Three unit tests in node-server read the shipped config — same precedent as
  `nginx-status-not-public.test.ts` — and fail if the `hash` directive is dropped,
  if `consistent` is reintroduced, or if the map stops matching the routes it
  derives from the route definitions. `UPGRADING.md` records that scaling
  node-server past one replica is now supported, and was not before.

## 0.2.0

## 0.1.0
