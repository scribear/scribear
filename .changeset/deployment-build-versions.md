---
'@scribear/base-fastify-server': minor
'@scribear/admin-server': minor
'@scribear/admin-webapp': minor
'@scribear/session-manager': patch
'@scribear/node-server': patch
'@scribear/monitoring-sidecar': patch
'@scribear/client-webapp': patch
'@scribear/standalone-webapp': patch
'@scribear/kiosk-webapp': patch
'@scribear/scribear-nginx': patch
---

Deployment Check now shows what each container was built from, so an operator
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
