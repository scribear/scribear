# Release Workflow

This repository follows the staging and versioning workflow proposed in issue `#55`.

## Branch model

- `staging` is the protected integration branch for day-to-day development.
- `main` is the protected production branch.
- Feature and fix branches should be created from `staging`.
- Release branches should be created from `staging` and merged **into
  `staging`** — the version bump is deployed and verified on the staging stack
  before it reaches production.
- Production is updated by a **promotion PR from `staging` into `main`**.
  Nothing is committed to `main` directly, and no release branch targets it.

Every change therefore reaches production the same way: branch → `staging` →
promotion PR → `main`. A release is not an exception to that path; it is one
more branch onto `staging` that happens to contain only version bumps and
changelogs.

## Container registry

- Images are published to the **GitHub Container Registry (GHCR)** at `ghcr.io/scribear/<service>`, and nowhere else.
- Docker Hub is no longer a publish target. The `scribear/<service>` images there are frozen at whatever was last pushed before the cutover — do not pull them, as they will silently serve stale code rather than fail.
- GHCR pushes authenticate with the built-in `GITHUB_TOKEN` (`packages: write`); no separate registry credentials are required.
- The deployment stack selects the registry via `IMAGE_REGISTRY` in `deployment/.env`, which defaults to `ghcr.io/scribear`.

## Container tags

- Pull requests build changed containers and publish a preview image named for
  the environment a merge would land in: a PR into `staging` publishes
  `staging-pr<number>`, a PR into `main` publishes `production-pr<number>`. The
  tag follows the PR head, so a reviewer can pull the exact build under review
  instead of rebuilding it. PRs from a fork build without publishing — their
  `GITHUB_TOKEN` cannot push.
  - Set the repository variable `PUBLISH_PR_IMAGES` (Settings → Secrets and
    variables → Actions → Variables) to `false` to switch preview images off
    entirely, or to `true` to publish them whatever the base branch is (tagged
    `<base-branch>-pr<number>`). Either override is a one-field change with no
    code edit — which is what you want when the registry needs draining in a
    hurry.
- Pushes to `staging` build changed containers with the `staging` and `staging-<commit-sha>` tags.
- Pushes to `main` build changed containers with the `latest` and `v<major>.<minor>.<patch>` tags.
- "Changed" is per image: a push rebuilds only the images whose workspace it
  touched, so an unchanged image keeps `latest` pointing at its previous build.
  It still gets the release's `v<version>`, though — `node-cd`'s
  `backfill-release-tags` job gives every image that this push did not rebuild
  the release tag as an alias of the manifest already tagged `latest`, so
  `IMAGE_TAG=v<version>` resolves for the whole stack and not just the parts
  that happened to change. (The transcription images need no backfill: a push
  to `main` always rebuilds all three.) An existing `v<version>` is never
  re-pointed, only missing ones are created.
- Release tags are not immutable. A push to `main` that carries no version bump
  — a hotfix promoted on its own — republishes `latest` **and** `v<version>`
  for whichever images it rebuilt, so that version tag moves for those images
  and stays put for the rest. If you need a fixed reference to exactly what was
  deployed, use the image digest or `staging-<sha>`, not the version tag.

## Version sources

- Node container versions come from the relevant package `package.json`.
- The transcription service version comes from `transcription_service/pyproject.toml`.
- Changesets is configured for the npm workspace packages in this repository.
- The transcription service version is still maintained in `pyproject.toml`.

Three files carry a version but are **not** updated by `changeset version`, and
each breaks something different if left behind:

- `transcription_service/pyproject.toml` — CI tags the published image
  `v<version>` from it, so a stale value tags the transcription images a
  release behind everything else.
- `transcription_service/uv.lock` — records the project's own version.
  `uv lock --check` fails once `pyproject.toml` moves, and `Dockerfile_CPU`
  installs with `uv sync --frozen`, so the mismatch rides into the image build.
- `package-lock.json` — `npm ci` fails when the lock disagrees with the
  workspace versions, which takes CI down rather than shipping something wrong.

## Changesets

Changesets does not gate anything here: no package is published to npm, no
workflow runs it, and deployments pull images by tag. It controls the version
number and the changelogs, nothing else. A `.changeset/*.md` file is a note —
one per PR — recording which packages changed, at what bump level, and why.
Notes accumulate until a release consumes them.

- Run `npm run changeset` on a feature branch to record the note alongside the
  change it describes, while the reasoning is still at hand.
- The npm packages are a changesets `fixed` group: every one of them moves to
  the same version together, whatever any individual note asked for.
- **Record breaking changes as `minor` while the project is pre-1.0.**
  Changesets does not apply the pre-1.0 convention, so a single `major` note
  takes every package straight to `1.0.0`. Two had to be re-recorded during the
  0.2.0 release for exactly this reason.
- Hand-editing a version instead of running `changeset version` consumes no
  notes: the images ship, but nothing lands in a changelog, and the next real
  release renumbers past whatever was hand-set.

## Cutting a release

1. Branch from `staging`.
2. `npm run changeset:version` — bumps every npm workspace package, writes the
   changelogs, and deletes the notes it consumed.
3. Bump `transcription_service/pyproject.toml` by hand to the same version.
4. `cd transcription_service && uv lock` (then `uv lock --check` to confirm).
5. `npm install --package-lock-only` at the root.
6. Open the release PR **into `staging`**, and check the diff is version lines,
   changelogs and the two lockfiles — nothing else.
7. Merge. The push to `staging` republishes every changed image as `staging` /
   `staging-<sha>`; deploy that to the staging stack and verify it there.
8. Open the promotion PR from `staging` into `main`. Merging it publishes
   `latest` and `v<version>`, which is what a production deployment pulls.

Steps 3–5 are the ones a release actually gets wrong; see "Version sources"
above for what each of those files breaks when it is skipped.

## Manual GitHub setup

- Create the `staging` branch on GitHub.
- Add branch protection rules for both `staging` and `main`.
