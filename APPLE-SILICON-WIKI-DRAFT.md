<!--
DRAFT ONLY - not yet published to the wiki.

A wiki reorg (metrics/alerts pages) is in flight, and this content is meant to
land in the wiki once that reorg settles the structure. Until then this file
lives here so it's easy to find and hand to whoever does that follow-up pass.

Suggested destination: a new "Developing on Apple Silicon" wiki page, linked
from the wiki Home page and from README.md's "Start here, by audience" table
the same way the other "Developing X" pages are. It doesn't belong on any one
existing "Developing <app>" page because it's cross-cutting - every one of
them is affected the same small set of ways.

Everything below is written as it should read once PR/branch
`feat/apple-silicon-support` (implementing APPLE-SILICON-FINDINGS.md's
recommendation) has actually landed on staging - the multi-arch publishing
section is contingent on that. Numbers and CI links marked "(this pass)" were
measured directly while building that branch, on this machine (amd64 Linux) -
not on real Apple Silicon; numbers marked "(exploration)" are carried over
from APPLE-SILICON-FINDINGS.md's own measurements on native
GitHub-hosted arm64 runners, which is the closest either investigation got to
a real Mac.
-->

# Developing ScribeAR on Apple Silicon

ScribeAR's dependency graph - Python wheels and npm native binaries alike - is
arm64-complete. There is nothing to port. A small number of fixes and one
documentation gap were all that stood between "should work" and "actually
works" on an M-series Mac; this page is that documentation gap.

## Requirements

- **macOS 14 (Sonoma) or newer.** `torch` 2.13.0, which `transcription_service`
  depends on, ships wheels tagged `macosx_14_0_arm64` only - there is no wheel
  for macOS 13 (Ventura) or earlier, and no code change fixes that short of
  moving off this torch version. Every other dependency resolves fine back to
  macOS 11.
- **Docker Desktop for Mac**, for the compose stack and for `testcontainers`
  suites (see below).
- Node `>=24.0.0` and a Python 3.12 toolchain (`uv`), same as any other
  platform - nothing arm64-specific here.

## Running the full stack

`docker compose up` now works out of the box in the default
`TRANSCRIPTION_DEVICE=cpu` configuration - the transcription service's NVIDIA
device reservation moved to an opt-in overlay
(`deployment/compose.gpu.yml`), so a GPU-less host (which is every Mac) no
longer fails to start the stack. Only reach for the overlay if you deliberately
set `TRANSCRIPTION_DEVICE=cuda`/`cuda128`, which is not meaningful on a Mac -
there is no NVIDIA device to pass through, on any Docker Desktop configuration,
ever.

**Build your own images rather than pulling published ones**, at least for
`transcription-service-*`:

```sh
CUDA_VARIANTS=none ./build-containers.sh dev
```

`build-containers.sh` runs plain `docker build` with no `--platform`, so on an
M-series Mac this produces native arm64 images with no changes needed.
`CUDA_VARIANTS=none` skips the two CUDA variants, which you cannot use on a Mac
and which otherwise cost several GB of download for nothing.

Point `IMAGE_REGISTRY`/`IMAGE_TAG` at what you just built, and **leave
`SCRIBEAR_DB_IMAGE`, `SCRIBEAR_SESSION_MANAGER_IMAGE` and
`SCRIBEAR_TRANSCRIPTION_SERVICE_IMAGE` unset** - set, they pull the CI-published
image instead of what you built locally.

The eleven Node and infra images (everything under `apps/*` and `infra/*` -
see `.github/node-images.json`) now publish as real multi-arch manifests
(`linux/amd64` + `linux/arm64`) from `staging`/`main`, so pulling
`node-server:staging` et al. on a Mac gets you a native image automatically -
no emulation, nothing to build yourself. **The three transcription images
(`transcription-service-cpu`/`-cuda`/`-cuda128`) are still amd64-only** as
published; build those locally with the command above. This is a deliberate,
cheaper-first scope decision, not an oversight - see "What's still amd64-only"
below.

## Native (non-container) development

`cd transcription_service && make install_dev_cpu` works on macOS 14+: the
lockfile resolves cleanly for `aarch64-apple-darwin` and pulls
`torch==2.13.0`, `torchaudio==2.11.0`, `ctranslate2==4.7.1`, `onnxruntime`,
`soundfile`, `numpy` - all arm64-native wheels, no Rosetta involved. Prefer
`install_dev_cpu` over the plain `install_dev` target: the latter is the
CUDA-flavoured extra CI itself uses and pulls several GB of `nvidia-*` wheels
you cannot use.

`npm ci` / `npm run build` / `npm run test:unit` at the repo root need nothing
special - every native npm dependency (esbuild, lightningcss, rolldown,
bcrypt) ships `darwin-arm64` prebuilds.

Three things that are easy to lose a morning to, none of them hard once known:

- **Chrome, for `npm run e2e:audio` and the a11y scans.** These scripts now
  check `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` as a
  fallback, so a standard Chrome install should just be found. Set
  `CHROME_PATH` explicitly if yours lives somewhere non-standard.
- **The Docker socket, for `testcontainers` suites**
  (`apps/session-manager`, `apps/admin-server`, `apps/node-server`,
  `infra/scribear-redis` all have integration suites that start real
  containers). On Docker Desktop for Mac, either enable *Settings → Advanced →
  Allow the default Docker socket to be used*, or export
  `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`. Nothing in the repo sets
  this for you and there's no `.testcontainers.properties`.
- **Leave the `SCRIBEAR_*_IMAGE` env vars unset** here too - the same
  testcontainers suites will happily build their own arm64 image locally
  instead of pulling a CI one, but only if those vars are unset.

### No GPU, ever - what that does and doesn't cost you

CTranslate2 (the faster-whisper backend) has no Metal/MPS backend, so there is
no path by which a Mac's GPU or Neural Engine accelerates Whisper transcription
- `device` in the provider config is only ever `"cuda"` or `"cpu"`. Silero VAD
(via `torch`) does expose MPS on macOS, but this codebase always runs it on
`device: "cpu"` regardless of platform, so that's moot too. Net: Whisper
transcription on a Mac runs on Apple Silicon's CPU, same as everywhere else
this repo runs CPU inference, and nothing runs on the Neural Engine. Do not
describe this setup as "MPS-accelerated" - it is not.

What you lose entirely: running the two CUDA images (you can still build
them, you just can't execute them - no Mac has an NVIDIA device), judging
**production GPU latency** (the CUDA provider config's `job_period_ms: 500` vs.
the CPU config's `job_period_ms: 5000` - a 10x difference - means a Mac's
timing characteristics are not representative of the GPU deployment), and
`vad_bench.py`'s CUDA comparison numbers.

What you don't lose: every provider (`debug`, `whisper-streaming`,
`lumen-granite`) runs CPU-only and works the same; no test is skipped for lack
of a GPU (nothing in the suite loads a real model); no CI job depends on one
either.

## What's still amd64-only, and why

Multi-arch publishing landed for the Node and infra images first because
they're what every `testcontainers` suite and the whole compose stack except
transcription depends on, and because they're the cheap half of the problem -
small, fast builds. The three transcription images
(`transcription-service-cpu`/`-cuda`/`-cuda128`) are left amd64-only in this
first pass, on purpose:

- `transcription-service-cpu` is exactly what you build locally with
  `CUDA_VARIANTS=none ./build-containers.sh dev` above, so there's a working
  path already, and adding it to the published multi-arch set is a
  small, well-understood follow-up once the Node/infra shape has run in
  production for a bit.
- The CUDA variants build on arm64 (their `nvidia/cuda` base images publish an
  SBSA/server-Arm `linux/arm64` tag) but cannot run anywhere a Mac can reach -
  there's no reason to pay CI cost publishing them for arm64.

## What was actually measured

**This pass** (building the multi-arch CI plumbing, on an amd64 Linux
machine - not a Mac):

- `docker buildx build --platform linux/arm64` for `apps/node-server/Dockerfile`
  completed successfully under QEMU emulation with no Dockerfile changes -
  confirms the Dockerfile itself is still arm64-correct after this work.
- A real end-to-end GitHub Actions run
  ([30303522816](https://github.com/scribear/scribear/actions/runs/30303522816))
  built a scratch image on both `ubuntu-24.04` (native amd64) and
  `ubuntu-24.04-arm` (native arm64) in parallel, pushed each by digest, and a
  `docker buildx imagetools create` merge job combined them into a real
  multi-arch OCI index - `docker buildx imagetools inspect` confirmed both a
  `linux/amd64` and a `linux/arm64` manifest present under one tag. Push to
  finished manifest: about 70 seconds total. This is the exact mechanism now
  wired into `node-cd.yml`'s `docker-build`/`docker-merge` jobs, proven for
  real rather than only designed.

**Original exploration** (`APPLE-SILICON-FINDINGS.md`, native GitHub-hosted
arm64 runners, cold cache, nothing published):

| Image | Native amd64 | Native arm64 | arm64 via QEMU |
| --- | --- | --- | --- |
| `transcription-service-cpu` | 34s | **28s** | 277s (9.9x native) |
| `node-server` | - | 68s | - |
| `client-webapp` | - | 67s | - |
| `scribear-nginx` | - | 1s | - |

The CPU transcription image - the one everyone expects to be the problem -
built *faster* natively on arm64 than on amd64. QEMU emulation, by contrast,
cost nearly 10x the native arm64 time on that same image, which is why this
repo's CI uses native `ubuntu-24.04-arm` runners (free for this public repo)
rather than `docker/setup-qemu-action`.

Neither investigation ran anything on real Apple Silicon hardware - both rest
on native arm64 **Linux** (GitHub-hosted runners) as the closest available
proxy, plus `uv`'s dependency resolution for `aarch64-apple-darwin`, which
proves the lockfile resolves for macOS but not that the wheels import or that
Docker Desktop itself behaves as expected. If you're reading this on an actual
Mac and something above doesn't hold, that's the gap - please correct this
page.
