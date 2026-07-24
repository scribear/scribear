# Release Workflow

This repository follows the staging and versioning workflow proposed in issue `#55`.

## Branch model

- `staging` is the protected integration branch for day-to-day development.
- `main` is the protected production branch.
- Feature and fix branches should be created from `staging`.
- Release branches should be created from `staging` and merged into `main`.

## Container registry

- Images are published to the **GitHub Container Registry (GHCR)** at `ghcr.io/scribear/<service>`, and nowhere else.
- Docker Hub is no longer a publish target. The `scribear/<service>` images there are frozen at whatever was last pushed before the cutover — do not pull them, as they will silently serve stale code rather than fail.
- GHCR pushes authenticate with the built-in `GITHUB_TOKEN` (`packages: write`); no separate registry credentials are required.
- The deployment stack selects the registry via `IMAGE_REGISTRY` in `deployment/.env`, which defaults to `ghcr.io/scribear`.

## Container tags

- Pull requests to `staging` or `main` build changed containers but publish nothing — the build proves the image compiles, and nothing consumed the old `PR-<number>` tags. To publish them again, set the repository variable `PUBLISH_PR_IMAGES` to `true` (Settings → Secrets and variables → Actions → Variables); no code change is needed.
- Pushes to `staging` build changed containers with the `staging` and `staging-<commit-sha>` tags.
- Pushes to `main` build changed containers with the `latest` and `v<major>.<minor>.<patch>` tags.

## Version sources

- Node container versions come from the relevant package `package.json`.
- The transcription service version comes from `transcription_service/pyproject.toml`.
- Changesets is configured for the npm workspace packages in this repository.
- The transcription service version is still maintained in `pyproject.toml`.

## Changesets

- Run `npm run changeset` on a release branch to record package release notes and bump types.
- Run `npm run changeset:version` before opening the release PR to `main`.
- `changeset version` updates package versions and changelogs for the npm workspace packages.

## Manual GitHub setup

- Create the `staging` branch on GitHub.
- Add branch protection rules for both `staging` and `main`.
