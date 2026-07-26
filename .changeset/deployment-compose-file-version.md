---
'@scribear/admin-server': minor
'@scribear/admin-webapp': minor
---

Deployment Check now notices when a stack is running an out-of-date
`deployment/compose.yml`.

`compose.yml` is not part of any image, so `docker compose pull` never updates
it: a deployment could run this month's images against last month's file —
missing services, missing environment variables, changed wiring — with every
container reporting green. Nothing in the stack could see it, and nothing could
be made to: reading the file from a container would mean mounting the Docker
socket (root-equivalent host access, for the one service on the public path) or
bind-mounting the file itself, which cannot work, because the stale compose file
is precisely the one that lacks the mount.

- **`compose.yml` carries its own version.** `COMPOSE_FILE_VERSION` is a plain
  literal in the `admin-server` service's `environment:`, deliberately not a
  `${...}` interpolation from `.env`: the point is the identity of the file, and
  an `.env` carried over from an older release is exactly the thing that goes
  stale. Nothing to add to `.env`, and it is not `:?`-guarded — it changes what
  is *reported*, never what runs, so it cannot stop a stack from starting.
- **admin-server compares it against the value baked into its image.**
  `GET /api/admin/v1/deployment-versions` gains a `composeFile` section:
  `match`, `stale` (the file is older than the images), `ahead` (the images are
  older than the file) and `unknown` (the file predates this check, so it is at
  least that old). `stale` and `ahead` are separate because the remedy differs —
  copy a file, or pull images — and `unknown` is separate from both because it
  is the absence of a measurement rather than a measured mismatch.
- **Deployment Check → Deployed versions** shows it as one more row beside the
  containers, with an icon and a word rather than a colour, plus a banner naming
  the fix whenever the file and the images disagree.
- **A unit test fails if the version stops being maintained.** It asserts the
  literal matches admin-server's constant and pins the sha256 of
  `deployment/compose.yml`, so any change to that file forces an author to
  decide whether operators must redeploy for it — a version nobody remembers to
  bump reports a match that was never verified.
