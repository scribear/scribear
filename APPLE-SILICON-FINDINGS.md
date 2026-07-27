# ScribeAR on Apple Silicon (arm64): findings

An exploration, not a migration. The question was: what would have to change for
ScribeAR to be developed on a modern Apple Silicon Mac, and for its containers to
be built and released from and for arm64?

Apple Silicon is `linux/arm64` under Docker Desktop, and a Mac has no NVIDIA GPU
to pass through under any configuration. Those two facts frame everything below.

Evidence comes from three places, and this document labels which is which:

- **Measured in CI.** Real builds on GitHub-hosted runners, run from this branch
  (`.github/workflows/arm64-probe.yml`, run
  [30228315304](https://github.com/scribear/scribear/actions/runs/30228315304)).
- **Measured locally, without building.** `docker manifest inspect` against the
  registry, and `uv sync --frozen --dry-run --python-platform …`, which resolves
  the lockfile for a foreign platform without installing anything.
- **Asserted from documentation or registry metadata.** Flagged inline as
  *(registry metadata)* or *(documentation)*. Not verified by execution.

No local Docker build was run for this investigation.

---

## Headline

**Building ScribeAR for `linux/arm64` is already possible today, and it is not
slower than amd64.** The dependency graph — Python wheels and npm native
binaries alike — is arm64-complete. Nothing needs porting. What is missing is a
decision and about a day of CI plumbing.

The measured surprise: the CPU transcription image, the one everybody expects to
be the problem, **built faster on arm64 than on amd64** on the same day, both
cold.

| Image | Native amd64 | Native arm64 | arm64 via QEMU on amd64 |
| --- | --- | --- | --- |
| `transcription-service-cpu` | 34s | **28s** | 277s (**9.9× the native arm64 cost**) |
| `transcription-service-cuda` | — | 289s | not measured |
| `node-server` | — | 68s | — |
| `client-webapp` | — | 67s | — |
| `scribear-nginx` | — | 1s | — |

*(measured in CI, cold, no build cache, nothing published)*

All ten probe jobs passed, including the QEMU cross-build and the CUDA image on
arm64.

The reason the repo believes otherwise is a comment in
`.github/actions/build-container/action.yml`:

```
# Disable arm builds due to extremely slow github actions.
```

That was true of the approach it describes — QEMU emulation on an amd64 runner,
now measured at **9.9× native** for the Python image — and is not true of the
approach that is now available. `ubuntu-24.04-arm` runners are GA and free for
public repositories, and `scribear/scribear` is public (verified: `gh repo view`
reports `"visibility":"PUBLIC"`). Every arm64 job in the probe run picked up a
runner within seconds:

```
Runner Image: ubuntu-24.04-arm   Version: 20260719.67.1
Operating System: Ubuntu 24.04.4 LTS      Azure Region: northcentralus
```

---

## Verdict per component

| Component | Verdict | Evidence |
| --- | --- | --- |
| 8 Node images (`apps/*`) | **Viable** | `node:24.10.0`, `node:24.10.0-alpine3.22` publish `linux/arm64/v8`. `node-server` and `client-webapp` both built natively on arm64 in CI. |
| 3 infra images (`infra/*`) | **Viable** | `nginx:1.29.7-alpine3.23`, `postgres:18.3-alpine3.23`, `redis:8.6.2-alpine` all publish `linux/arm64/v8`. `scribear-nginx` built on arm64 in CI. `scribear-db` compiles pg_cron from source, which is the arm64-correct pattern (no arch in any URL). |
| `transcription-service-cpu` | **Viable** | Built natively on arm64 in 28s. Every native extension imports; see the runtime report below. |
| `transcription-service-cuda` / `-cuda128` | **Builds on arm64, useless on a Mac** | The `cuda` variant built natively on arm64 in CI (289s) and reports `arch=arm64` / `ct2 devices 0`. Both `nvidia/cuda` tags publish `linux/arm64`, but that is the SBSA (server-class Arm) build and no Mac has a CUDA device. See "The CUDA images" below. |
| Python dependency lock | **Viable** | Resolves cleanly for `aarch64-unknown-linux-gnu`, both the CPU and the CUDA extra. `uv lock --check` is clean, so no relock is needed. |
| Native macOS dev (`make install_dev_cpu`) | **Viable on macOS 14+** | Resolves for `aarch64-apple-darwin`; **fails on macOS 13 or earlier** because `torch` 2.13.0 ships only `macosx_14_0_arm64`. |
| Node workspaces on macOS arm64 | **Viable** | All four native-binary families (esbuild, lightningcss, rolldown, bcrypt) have complete `darwin-arm64` and `linux-arm64` coverage in `package-lock.json`. |
| Python test suites on arm64 | **Viable** | `make test_unit` and `make test_integration` both pass on native arm64 in CI. |
| Node test suites on arm64 | **Viable** | `npm ci` + `npm run build` + `npm run test:unit` on native arm64 in CI. |
| testcontainers integration suites | **Viable, with one env caveat** | No `network_mode: host`, no `/var/run/docker.sock`, no `DOCKER_HOST`, no `withPlatform()` anywhere. All use `getHost()` + `getMappedPort()`. |
| `deployment/compose.yml` | **Blocked — needs an override** | The `driver: nvidia` device reservation is unconditional. |
| Publishing multi-arch to GHCR | **Needs work** | Every published image is a single-platform `linux/amd64` index today. |
| GPU transcription on a Mac | **Impossible, permanently** | Not a porting problem. No Mac has an NVIDIA device. |

---

## Blockers, hardest first

### 1. `deployment/compose.yml` requests an NVIDIA device unconditionally

The only thing that actually stops a Mac operator dead. `transcription-service`
declares:

```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

with no profile guard and no dependence on `TRANSCRIPTION_DEVICE` — whose default
is `cpu` (`deployment/.env.example`, documented there as "`cpu` - no GPU
required"). Docker Desktop on Apple Silicon has no `nvidia` device driver, so
`docker compose up` fails to create that container even in the default CPU
configuration. This blocks the entire stack, not one service, and therefore also
blocks the `tools/e2e-audio` flow, which needs the stack up at
`https://localhost`.

**To clear it:** an override file (`deployment/compose.gpu.yml` holding the
reservation, or `deployment/compose.nogpu.yml` nulling it out), or move the
reservation behind a compose profile the way `watchtower` already does in the
same file. Either is a one-block change.

Worth noting this is **not an arm64 bug**. It equally breaks any GPU-less amd64
host running the documented CPU default, so it is a pre-existing latent bug that
Apple Silicon merely makes unavoidable. Fixing it is worth doing regardless of
whether anyone ever develops on a Mac.

### 2. Nothing is published for arm64, so a Mac pulls amd64 and emulates

`.github/actions/build-container/action.yml` pins `platforms: "linux/amd64"`,
with `# platforms: "linux/amd64,linux/arm64"` and `# uses: docker/setup-qemu-action@v3`
commented out beside it. Confirmed against the registry: every published tag is a
single-platform index.

```
ghcr.io/scribear/node-server:staging                  -> ['linux/amd64']
ghcr.io/scribear/session-manager:staging              -> ['linux/amd64']
ghcr.io/scribear/client-webapp:staging                -> ['linux/amd64']
ghcr.io/scribear/transcription-service-cpu:staging    -> ['linux/amd64']
ghcr.io/scribear/transcription-service-cuda:staging    -> ['linux/amd64']
ghcr.io/scribear/scribear-nginx:staging               -> ['linux/amd64']
```

So `docker compose up` on a Mac works, slowly, under Rosetta emulation — which is
the worst of the available outcomes, because it looks like it succeeded. A Mac
operator's transcription container would run x86 CTranslate2 under emulation.

It is also worth recording that **the arm64 path in this repo appears never to
have run successfully**. The per-arch buildcache convention survives in the tag
names (`buildcache-staging-linux-amd64`), but:

```
ghcr.io/scribear/node-server:buildcache-staging-linux-arm64            => absent
ghcr.io/scribear/node-server:buildcache-main-linux-arm64               => absent
ghcr.io/scribear/transcription-service-cpu:buildcache-staging-linux-arm64 => absent
ghcr.io/scribear/node-server:buildcache-staging-linux-amd64            => EXISTS
ghcr.io/scribear/transcription-service-cpu:buildcache-staging-linux-amd64 => EXISTS
```

**To clear it:** see "Releasing multi-arch images" below. Roughly a day of work.

### 3. macOS 13 (Ventura) or earlier cannot install the Python dev environment

Not arm64's fault, and easy to miss. `uv sync` for `aarch64-apple-darwin`:

```
error: Distribution `torch==2.13.0 @ registry+https://download.pytorch.org/whl/cpu`
can't be installed because it doesn't have a source distribution or wheel for the
current platform

hint: You're on macOS (`macosx_13_0_arm64`), but `torch` (v2.13.0) only has wheels
for the following platform: `macosx_14_0_arm64`
```

The same command with `MACOSX_DEPLOYMENT_TARGET=14.0` and `15.0` resolves
completely — 75 packages, including `torch 2.13.0`, `torchaudio 2.11.0`,
`ctranslate2 4.7.1`, `onnxruntime 1.27.0`, `soundfile 0.13.1`, `numpy 2.3.3`.

So the constraint is real but narrow: **macOS 14 Sonoma or newer**. Every Apple
Silicon Mac can run it; a machine left on Ventura cannot. Worth one line in the
dev docs, nothing more. There is no code change that clears it short of moving
off torch 2.13.

### 4. Three developer tools hardcode Linux-only Chrome paths

`tools/e2e-audio/kiosk-audio-e2e.mjs`, `tools/a11y/axe-scan.mjs` and
`tools/a11y/axe-scan-authed.mjs` each carry:

```js
const CHROME_CANDIDATES = [process.env.CHROME_PATH, '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
```

None of the four exists on macOS. It degrades politely — `resolveChrome()` throws
with a message naming `CHROME_PATH` — so this is a DX papercut, not a blocker.

**To clear it:** add
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` to the candidate
list in all three. Ten minutes.

### 5. The node_modules cache key would collide the day an arm64 runner is added

`.github/actions/setup-node/action.yml`:

```yaml
key: node-modules-${{ runner.os }}-${{ inputs.node-version }}-${{ hashFiles('package-lock.json') }}
```

`runner.os` is `Linux` on both amd64 and arm64 runners. The moment any job in the
real pipeline runs on `ubuntu-24.04-arm`, it saves a tree of aarch64 native
binaries under a key every amd64 job restores, and vice versa. Latent today,
guaranteed to bite tomorrow.

**To clear it:** add `${{ runner.arch }}` to the key. One line. Do it *before*
adding an arm64 runner, not after.

(The probe workflow on this branch deliberately does not use that composite
action, precisely so it could not poison the cache.)

---

## 1. Which images can build for arm64

Base image platform support, from `docker manifest inspect`:

| Base image | Platforms | Used by |
| --- | --- | --- |
| `node:24.10.0` | amd64, **arm64/v8**, ppc64le, s390x | all 8 app build stages |
| `node:24.10.0-alpine3.22` | amd64, **arm64/v8**, s390x | node-server, session-manager, admin-server, monitoring-sidecar runtime |
| `nginx:1.29.7-alpine3.23` | 386, amd64, arm/v6, arm/v7, **arm64/v8**, ppc64le, riscv64, s390x | 4 webapps + scribear-nginx |
| `postgres:18.3-alpine3.23` | same broad set incl. **arm64/v8** | scribear-db |
| `redis:8.6.2-alpine` | same broad set incl. **arm64/v8** | scribear-redis |
| `python:3.12.11-slim` | same broad set incl. **arm64/v8** | Dockerfile_CPU |
| `ghcr.io/astral-sh/uv:0.11.2` | amd64, **arm64** | both transcription Dockerfiles |
| `nvidia/cuda:12.2.2-cudnn8-runtime-ubuntu22.04` | amd64, **arm64** | Dockerfile_CUDA (`cuda`) |
| `nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04` | amd64, **arm64** | Dockerfile_CUDA (`cuda128`) |
| `nickfedor/watchtower:latest` | 386, amd64, arm/v6, **arm64**, riscv64 | compose, `autoupdate` profile only |

**Not one base image is amd64-only.** This was the most likely hard blocker and
it simply is not there.

### The CUDA images

Both tags in `transcription_service/cuda-variants.json` do publish `linux/arm64`
— which is the surprise, and which must not be over-read. NVIDIA's arm64 CUDA
images target SBSA, i.e. server-class Arm platforms such as Grace and
GH200, and Jetson *(documentation / registry metadata — not verified by
execution)*. Even a successful arm64 build of `Dockerfile_CUDA` produces an image
whose CUDA runtime has no device to talk to on a Mac, because there is no
NVIDIA hardware and Docker Desktop for Mac has no GPU passthrough of any kind.

The probe confirms both halves of that. `Dockerfile_CUDA` **built** natively on
arm64 in 289s against `nvidia/cuda:12.2.2-cudnn8-runtime-ubuntu22.04` — the
deadsnakes fallback for Python 3.12 on the 22.04 base worked on arm64 too — and
the resulting image reports:

```
arch=arm64 os=linux
machine      aarch64
ct2 devices  0
```

`ct2 devices 0` on a GPU-less runner is expected and proves nothing about real
Arm GPU hardware; what it does establish is that the image builds and its CUDA
Python stack loads on aarch64.

The right framing is: the CUDA images are **irrelevant on a Mac**, not blocked. A
Mac developer builds and runs `transcription-service-cpu` and never touches them.
`build-containers.sh` already supports exactly this — `CUDA_VARIANTS=none
./build-containers.sh dev` skips them.

Their *arm64 buildability* still matters, but for a different question than the
one asked: it means a Grace/GH200 or Jetson deployment is within reach. That is
out of scope here.

---

## 2. Python wheels for arm64 Linux

The answer is unambiguous, and it distinguishes "no wheel exists" from "the
lockfile did not ask for one" — because `uv.lock` is a *universal* lock, and
inspection shows it already carries the aarch64 wheels.

Every heavyweight dependency, straight out of `uv.lock`:

| Package | manylinux aarch64 | macOS arm64 |
| --- | --- | --- |
| `ctranslate2` 4.7.1 | `manylinux_2_27_aarch64.manylinux_2_28_aarch64` | `macosx_11_0_arm64` |
| `torch` 2.13.0+cpu (pytorch-cpu index) | `manylinux_2_28_aarch64` | — (darwin gets plain `2.13.0`, `macosx_14_0_arm64`) |
| `torch` 2.13.0 (PyPI, CUDA build) | `manylinux_2_28_aarch64` | `macosx_14_0_arm64` |
| `torchaudio` 2.11.0+cpu | `manylinux_2_28_aarch64` | — (darwin gets plain `2.11.0`, `macosx_11_0_arm64`) |
| `onnxruntime` 1.27.0 | `manylinux_2_27_aarch64.manylinux_2_28_aarch64` | `macosx_14_0_arm64` |
| `soundfile` 0.13.1 | `manylinux_2_28_aarch64` | `macosx_11_0_arm64` |
| `numpy` 2.3.3 | `manylinux_2_27_aarch64` + `musllinux_1_2_aarch64` | `macosx_11_0_arm64`, `macosx_14_0_arm64` |
| `av` 18.0.0 | `manylinux_2_28_aarch64` + `musllinux_1_2_aarch64` | `macosx_14_0_arm64` |
| `tokenizers` 0.23.1 | `manylinux_2_17_aarch64` + `musllinux_1_2_aarch64` | `macosx_11_0_arm64` |
| `triton` 3.7.1 | `manylinux_2_27_aarch64` | n/a (linux only) |
| every `nvidia-*` / `cuda-*` runtime package | aarch64 present | n/a |

`soundfile` bundles `libsndfile` in its wheel, so there is no system library to
install — the `manylinux_2_28_aarch64` wheel is self-contained.

### Resolution verified without building anything

```
uv sync --frozen --dry-run --no-install-project --python-platform <plat> --extra …
```

| Platform | Extras | Result |
| --- | --- | --- |
| `aarch64-unknown-linux-gnu` | `faster-whisper` + `silero-vad-cpu` | **resolves** (`torch==2.13.0+cpu`, `torchaudio==2.11.0+cpu`) |
| `aarch64-unknown-linux-gnu` | `faster-whisper` + `silero-vad` (CUDA) | **resolves** (`torch==2.13.0`, `triton==3.7.1`) |
| `aarch64-unknown-linux-gnu` | base only | **resolves** |
| `x86_64-unknown-linux-gnu` | `faster-whisper` + `silero-vad-cpu` | resolves (control) |
| `aarch64-apple-darwin`, `MACOSX_DEPLOYMENT_TARGET=14.0` / `15.0` | `dev` + `faster-whisper` + `silero-vad-cpu` | **resolves**, 75 packages |
| `aarch64-apple-darwin`, target `13.0` | same | **fails** on `torch` (blocker 3) |

`uv lock --check` is clean. **No relock is needed for arm64.** That is the single
most important line in this section: the lockfile is already correct, so there is
no risk of an arm64 effort perturbing the amd64 resolution.

### The `[tool.uv] conflicts` declaration holds up

The `silero-vad` / `silero-vad-cpu` conflict declaration and the explicit
`pytorch-cpu` index survive the arch change intact, because the lock's forks are
keyed on `sys_platform`, not on architecture:

```toml
[[package]] name = "torch" version = "2.13.0+cpu"
source = { registry = "https://download.pytorch.org/whl/cpu" }
resolution-markers = [ "sys_platform != 'darwin'" ]

[[package]] name = "torch" version = "2.13.0"
source = { registry = "https://download.pytorch.org/whl/cpu" }
resolution-markers = [ "sys_platform == 'darwin'" ]
```

That third fork is what makes macOS work: `download.pytorch.org/whl/cpu` serves
macOS arm64 as plain `2.13.0` (no `+cpu` local version, since a macOS torch build
is CPU/MPS anyway), and the lock already models that. The comment in
`pyproject.toml` explaining why the extras must be declared conflicting remains
exactly as true on arm64 as on amd64 — and the CUDA extra still correctly resolves
to the PyPI CUDA torch on `aarch64` Linux, dragging in the `nvidia-*-cu13`
aarch64 wheels rather than silently degrading to CPU.

### Confirmed at runtime in the arm64 container

Job 3 ran the image it had just built and imported the whole native stack.
Verbatim output — measured in CI, not asserted:

```
arch=arm64 os=linux
machine       aarch64
ctranslate2   4.7.1
ct2 cuda      0
ct2 compute   {'int8_float32', 'int8', 'float32'}
torch         2.13.0+cpu
torch cuda    False
torch mps     False
torchaudio    2.11.0+cpu
onnxruntime   1.27.0 ['AzureExecutionProvider', 'CPUExecutionProvider']
soundfile     0.13.1 1.2.2
numpy         2.3.3
```

Nothing about the aarch64 wheel set is theoretical. Three things in that output
are worth reading closely:

- **`soundfile 0.13.1 1.2.2`** — the bundled `libsndfile` loaded. No system
  package needed on aarch64, exactly as on amd64.
- **`ct2 compute {'int8_float32', 'int8', 'float32'}`** — the CTranslate2 compute
  types available on arm64 CPU. Every shipped provider template uses
  `"compute_type": "float32"` (verified in
  `transcription_service/provider_config.template.json`,
  `deployment/provider_config.template.json` and
  `deployment/provider_config.cuda.template.json`), so **nothing in the repo asks
  for a type arm64 lacks today**. But `float16`, `int8_float16` and `bfloat16` are
  not in that set, so a future config change to a half-precision CPU compute type
  would break a Mac developer while passing on the GPU boxes. Worth knowing before
  someone makes that change. *(The equivalent set on amd64 CPU was not measured —
  see the final section.)*
- **`torch mps False`** — as expected inside a Linux container, and a reminder
  that MPS is not part of this story even on a real Mac (see §3).

---

## 3. Native (non-container) development on macOS arm64

**Yes, `cd transcription_service && make install_dev_cpu` would work on a Mac** —
on macOS 14 or newer. Verified by lockfile resolution for `aarch64-apple-darwin`
(see above) and by actually running the same Make target on native `aarch64` Linux
in CI:

```
install_dev_cpu (the Mac developer's command) ... success   (6s)
Report the installed native stack             ... success
Unit tests on arm64                           ... success  (50s)
Integration tests on arm64                    ... success  (26s)
```

`make install_dev` — the CUDA-flavoured extra that CI itself uses — also succeeds
on arm64 (23s), pulling the `nvidia-*-cu13` aarch64 wheels. So even the default
Make target is not arm64-hostile, though a Mac developer should prefer
`install_dev_cpu` and avoid downloading several GB of CUDA runtime they can never
use.

**This is CPU inference, and nothing else.** Being explicit because it is the
easiest thing in this whole investigation to get wrong:

- faster-whisper is a CTranslate2 frontend, and **CTranslate2 has no Metal or MPS
  backend**. There is no path by which a Mac's GPU or Neural Engine accelerates
  Whisper transcription here. `device` in the provider config is
  `Literal["cuda"] | Literal["cpu"]` — those are the only two values the code
  models.
- `torch` on macOS arm64 *does* expose MPS, and the probe prints
  `torch.backends.mps.is_available()`, but the only thing this codebase uses torch
  for is the Silero VAD TorchScript model. Silero VAD already defaults to
  `device: "cpu"` — and the comment above that default records that CUDA measured
  *slower* (128.1 ms vs 74.5 ms for a 30 s buffer on an RTX 5070 Ti) and is
  "additionally broken today and fails quietly". So VAD on a Mac is CPU, by the
  same reasoning that makes it CPU on a GPU box.

Net: a Mac developer gets Apple Silicon's (very good) CPU performance for Whisper,
and no accelerator. **Do not describe this as "MPS-accelerated".** It is not.

### Node workspaces on macOS arm64 — verified, not assumed

Every package in `package-lock.json` carrying a `cpu`/`os`/`libc` field was
enumerated (52 entries), plus every `hasInstallScript` package:

| Family | `darwin-arm64` | `linux-arm64` | Notes |
| --- | --- | --- | --- |
| `esbuild` 0.28.1 | `@esbuild/darwin-arm64` present | `@esbuild/linux-arm64` present | 26 platform packages in `optionalDependencies` |
| `lightningcss` 1.33.0 | present | `-gnu` **and** `-musl` present | musl matters: the Alpine runtime stages |
| `rolldown` 1.1.5 (vite 8's bundler; no `@rollup/rollup-*` in this lock at all) | `@rolldown/binding-darwin-arm64` | `-linux-arm64-gnu` and `-linux-arm64-musl` | |
| `bcrypt` 6.0.0 — the **only production** native module | `prebuilds/darwin-arm64/` | `prebuilds/linux-arm64/bcrypt.glibc.node` and `.musl.node` | `prebuildify`, all prebuilds in one tarball; no `node-gyp` compile, so the Alpine stage's missing toolchain is as fine on arm64 as on amd64 |
| `fsevents` | darwin-only by design, optional | n/a | benign |

Absent entirely (nothing to fix): `@swc/core-*`, `sharp`/`@img/*`,
`better-sqlite3`, `canvas`, `sass-embedded`, `@parcel/watcher`, `msw`,
`playwright`, `cypress`, `@napi-rs/*` native bindings, `@tailwindcss/oxide`.

`.npmrc` contains only `save-exact=true` — critically, **no `omit=optional`**,
which would have broken the per-platform optional-dependency selection that all
of the above relies on. No `package.json` anywhere declares `os` or `cpu`; the
only relevant field is the root's arch-neutral `"engines": { "node": ">=24.0.0" }`.

Confirmed in CI: `npm ci` on native arm64 selected exactly the arm64 binaries and
nothing else.

```
node_modules/@rolldown/binding-linux-arm64-gnu/rolldown-binding.linux-arm64-gnu.node
node_modules/lightningcss-linux-arm64-gnu/lightningcss.linux-arm64-gnu.node
--- per-platform optional packages present:
node_modules/@esbuild:
linux-arm64
```

`npm ci` (31s), `npm run build` (63s, all 36 workspaces including four vite
builds) and `npm run test:unit` (65s) all passed on `ubuntu-24.04-arm`.

One flagged risk did **not** materialise. `puppeteer` 25.3.0 is auto-installed as
a non-optional peer of `@axe-core/puppeteer`, it has `hasInstallScript`, and its
postinstall downloads a Chrome build — and Chrome for Testing publishes no
`linux-arm64` binary. That looked like it should break `npm ci` inside an arm64
container. It did not: the `npm ci` above succeeded, as did the `node-server` and
`client-webapp` image builds, each of which runs `npm ci` twice. So the
postinstall tolerates the missing arm64 build. Worth knowing that the download is
dead weight regardless of arch — the a11y scripts use `puppeteer-core` with an
explicit `executablePath` and never touch it — so `puppeteer_skip_download=true`
in `.npmrc` would be a free win on every platform. Not a blocker; a cleanup.

---

## 4. Running the stack on a Mac

### What an operator must override

One thing, and it is blocker 1: the `driver: nvidia` device reservation. Until
that is guarded, `docker compose up` fails on Apple Silicon in the default
`TRANSCRIPTION_DEVICE=cpu` configuration.

Everything else in `deployment/compose.yml` is Mac-clean. Verified absent from the
whole repo: any `platform:` key in any compose file, any `--platform` flag in any
Dockerfile or script, `network_mode: host` (which does not work on Docker Desktop
for Mac), `extra_hosts`, `host.docker.internal`, `172.17.0.1`, `privileged:`, and
any `devices:` other than the NVIDIA one. Port bindings are Mac-safe: nginx
publishes `${NGINX_PORT:-80}:80` / `${NGINX_HTTPS_PORT:-443}:443`, `scribear-db`
binds `127.0.0.1:5432:5432`, everything else is `expose:` only. The only Docker
socket mount in the repo is `watchtower`, behind the off-by-default `autoupdate`
profile.

And the second thing an operator must do, which is subtler: **do not pull the
published images.** They are amd64 (blocker 2), so `docker compose up` on a Mac
silently emulates. Until multi-arch manifests exist, a Mac operator should build
locally with `CUDA_VARIANTS=none ./build-containers.sh dev` and point
`IMAGE_REGISTRY`/`IMAGE_TAG` at the result. `build-containers.sh` uses plain
`docker build` with no `--platform`, so on an M-series Mac it produces native
arm64 images correctly with no changes at all.

### testcontainers suites

Four suites start containers, all on `testcontainers` 12.0.4:

| Suite | Images |
| --- | --- |
| `apps/session-manager/tests/integration/global-setup.ts` | `$SCRIBEAR_DB_IMAGE`, else builds `infra/scribear-db` |
| `apps/admin-server/tests/integration/global-setup.ts` | `postgres:16-alpine`, `redis:8-alpine` (stock, multi-arch) |
| `infra/scribear-redis/tests/integration/global-setup.ts` | `redis:8-alpine` |
| `apps/node-server/tests/integration/global-setup.ts` | scribear-db + session-manager + `redis:8-alpine` + transcription-service (CPU), on a `new Network()` |

All of them address services via `container.getHost()` + `getMappedPort()`, which
is the Mac-portable pattern, and none calls `withPlatform()`, so each builds
natively for the host arch. The node-server suite is GPU-free by construction — it
injects a provider config with `contexts: []` and only the `debug` provider,
with an in-file comment saying it is "so the container boots without GPU deps even
on the CPU image".

Two Mac caveats, neither in the repo's control:

- **Leave `SCRIBEAR_DB_IMAGE`, `SCRIBEAR_SESSION_MANAGER_IMAGE` and
  `SCRIBEAR_TRANSCRIPTION_SERVICE_IMAGE` unset on a Mac.** Set, they feed in
  amd64 CI images and you get emulation; unset, the suites build arm64 locally.
- **Docker socket discovery.** Nothing in the repo sets `DOCKER_HOST` and there is
  no `.testcontainers.properties`, so testcontainers uses its own strategy chain.
  On Docker Desktop for Mac the developer must either enable "Allow the default
  Docker socket to be used" or export
  `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock` *(documentation — this is a
  Docker Desktop behaviour, not something measured here)*. Undocumented in the
  repo today; worth a line in a Mac setup note.

Ryuk is left at its default (never disabled anywhere) and its reaper image is
multi-arch, so it is fine.

### Hardcoded amd64 assumptions found — the full list

Searched for and **not found** anywhere: `uname -m`, `dpkg --add-architecture`,
`TARGETARCH`, `TARGETPLATFORM`, `BUILDPLATFORM`, `DOCKER_DEFAULT_PLATFORM`, any
arch string in a download URL, any `process.arch` / `os.arch()` branch. The only
`curl` fetch in any Dockerfile is `infra/scribear-db`'s pg_cron **source** tarball,
compiled in-image — the arm64-correct pattern.

Found:

| Location | Issue |
| --- | --- |
| `.github/actions/build-container/action.yml` | `platforms: "linux/amd64"`, arm64 + QEMU commented out (blocker 2) |
| `.github/actions/build-container/action.yml`, `.github/actions/prepare-test-container/action.yml` | `buildcache-*-linux-amd64` tag names — cosmetic today, must become per-arch |
| `.github/actions/setup-node/action.yml` | cache key keyed on `runner.os`, not `runner.arch` (blocker 5) |
| all 23 `runs-on:` in `.github/workflows/` | `ubuntu-latest` — zero arm64 coverage, so an arm64 regression cannot be caught |
| `deployment/compose.yml` | the NVIDIA reservation (blocker 1) |
| `tools/e2e-audio/`, `tools/a11y/` | Linux-only Chrome paths (blocker 4) |

---

## 5. Releasing multi-arch images

### Recommendation: native `ubuntu-24.04-arm` runners. Not QEMU.

The repo already tried the QEMU shape and abandoned it with the comment "Disable
arm builds due to extremely slow github actions". That judgement was correct for
QEMU and is now obsolete as a reason not to ship arm64, because the constraint it
was working around no longer applies:

- `scribear/scribear` is **public**, so `ubuntu-24.04-arm` is GA and **free**
  (0× minutes multiplier for public repos) *(documentation — the free-tier
  multiplier is GitHub billing policy, not something this run measured; that the
  runners are **available** to this repo is measured, in the probe run)*.
- Native arm64 is **not slower than amd64** for these images. Measured, same day,
  both cold: the CPU transcription image took 28s on arm64 and 34s on amd64.
- **QEMU costs 9.9× native arm64 on the Python image**, measured: 277s versus 28s
  (and 8.1× the 34s amd64 baseline). Exactly as predicted: the expensive part of
  `Dockerfile_CPU` is not downloading wheels (arch-neutral I/O) but `uv sync` with
  `UV_COMPILE_BYTECODE=1`, and every byte of that bytecode compilation runs
  interpreted under emulation.

Two honest qualifications on that QEMU number, because it cuts slightly against
the repo's existing comment:

- **277s is slow, not "extremely slow".** 4.6 minutes for one image is survivable.
  If the whole decision were about the CPU transcription image alone, QEMU would be
  a defensible shortcut. So the original comment somewhat overstates the case for
  that particular image.
- **But it does not scale.** Applied to the CUDA image, which took 289s *natively*
  on arm64, a 10× multiplier implies roughly 45–50 minutes — and the CD matrix
  builds two CUDA variants. Multiply across 14 images on a single amd64 leg and the
  emulated arm64 half dominates the pipeline. Native runners make the arm64 leg a
  *sibling* of the amd64 leg rather than a multiplier on it, so wall clock barely
  moves. That is the argument, and it holds regardless of how the 277s reads.

The shape to build:

1. **Split `docker-build` into a matrix over `[ubuntu-24.04, ubuntu-24.04-arm]`**,
   each job building and pushing *by digest* with
   `outputs: type=image,push-by-digest=true,name-canonical=true`, and giving each
   arch its own buildcache tag (the `-linux-amd64` / `-linux-arm64` convention the
   tag names already anticipate).
2. **Add a `merge` job** that runs `docker buildx imagetools create` over the two
   digests to publish the multi-arch manifest under the real tags from
   `resolve-container-tags`. This is the "final manifest-only push" the existing
   comment in `build-container` refers to.
3. **Add `${{ runner.arch }}` to the `setup-node` cache key first** (blocker 5).
4. Restrict the arm64 leg to `staging`/`main` pushes if PR wall-clock matters —
   PR CI's job is to prove the image compiles, and it already does that on amd64.
   This halves the added cost of the change at no real loss.

Cost: roughly doubles `docker-build` *job count*, not wall clock, since the two
arch legs are siblings. Complexity: one new merge job and per-arch cache tags.
Call it a day of work including getting the digest plumbing right.

The alternative — uncommenting `setup-qemu-action` and setting
`platforms: "linux/amd64,linux/arm64"` — is a two-line change and is the wrong
one. It serialises both architectures into one build step, and the emulated half
of it is the transcription image. That is precisely the configuration the repo
already rejected on measured grounds.

**A separate decision, and the cheaper one:** publish multi-arch for the *eleven
Node and infra images only* (`.github/node-images.json`), and leave the three
transcription images amd64-only at first. Those eleven are small, fast, and are
what every testcontainers suite and the whole compose stack except one service
depends on. It gets a Mac developer a native stack for everything but
transcription — which is also the one component they can build locally in 28s, so
it is the cheapest gap to leave open.

### What was actually run on GitHub Actions

Workflow `.github/workflows/arm64-probe.yml`, added on this branch only. It
publishes nothing, pushes nothing, writes no build cache, and reuses none of the
existing composite actions — in particular not `setup-node`, so it could not
poison the shared `node_modules` cache.

One process note worth recording, because it will trip up the next person:
**`workflow_dispatch` is only dispatchable for a workflow file that exists on the
repository's default branch.** `gh workflow run --ref explore/apple-silicon`
returned `HTTP 404: Not Found` on eight attempts over two minutes, because the
file lives only on this branch and the default branch is `staging`. The workaround
that does not require touching `staging` is a `push:` trigger filtered to this one
branch — a push event runs the workflow definition from the branch that was
pushed. That is how run 30228315304 was triggered.

Results, run
[30228315304](https://github.com/scribear/scribear/actions/runs/30228315304):

**All ten jobs succeeded.** There is no failing case to report — which is itself
the finding, and a weaker one than a failure naming a missing wheel would have
been, but it is what the builds actually did.

| # | Job | Runner | Result | Time |
| --- | --- | --- | --- | --- |
| 1 | arm64 runner availability | `ubuntu-24.04-arm` | **success** | 0s |
| 2 | node-server image, native arm64 | `ubuntu-24.04-arm` | **success** | 68s build |
| 3 | transcription CPU image, native arm64 | `ubuntu-24.04-arm` | **success** | **28s build** |
| 4 | transcription CPU image, native amd64 (baseline) | `ubuntu-24.04` | **success** | 34s build |
| 5 | transcription CPU image, arm64 under QEMU | `ubuntu-24.04` | **success** | **277s cross-build** |
| 6 | transcription CUDA image, native arm64 | `ubuntu-24.04-arm` | **success** | 289s build |
| 7 | `install_dev_cpu` + unit + integration tests, native arm64 | `ubuntu-24.04-arm` | **success** | 6s install, 50s unit, 26s integration |
| 8 | `install_dev` (CUDA extra), native arm64 | `ubuntu-24.04-arm` | **success** | 23s |
| 9 | client-webapp + scribear-nginx images, native arm64 | `ubuntu-24.04-arm` | **success** | 67s + 1s |
| 10 | `npm ci` + `npm run build` + `npm run test:unit`, native arm64 | `ubuntu-24.04-arm` | **success** | 31s + 63s + 65s |

Jobs 3 and 6 additionally *ran* the images they built and reported the state of
the native stack inside them; that output is quoted verbatim in §2 and §1
respectively. Job 10 reported which per-platform npm binaries were selected,
quoted in §3.

The only warnings in the whole run were incidental: an `onnxruntime` PCI-bus
discovery notice on the Azure Arm host (cosmetic), a `setup-uv` cache-reservation
race between jobs 7 and 8 (both jobs still passed), and a GitHub deprecation
notice that `docker/setup-qemu-action@v3` and `docker/setup-buildx-action@v3`
target Node 20. That last one is not arm64-specific but it does affect the real
pipeline, which uses `setup-buildx-action` in `build-container`.

---

## What development on a Mac would actually look like

**Day to day, almost normal.** `npm ci`, `npm run build`, `npm run test:unit`,
`npm run test:integration` — all fine, natively, with no emulation. The
testcontainers suites build their own arm64 images and run. `cd
transcription_service && make install_dev_cpu && make test_unit &&
make test_integration` — fine. Whisper transcription runs on CPU, which on an
M-series chip is respectable. `./build-containers.sh dev` with
`CUDA_VARIANTS=none` produces a full native arm64 stack.

The friction, in the order a new Mac developer would hit it:

1. `docker compose up` fails on the NVIDIA reservation. Needs an override file
   that does not exist yet. **This is the one that makes the experience feel
   broken rather than limited.**
2. `CHROME_PATH` must be exported before `npm run e2e:audio` or the a11y scans.
3. The Docker socket must be exposed for testcontainers.
4. `SCRIBEAR_*_IMAGE` must be left unset, or you get emulated amd64 containers.
5. macOS must be 14+.

None of 2–5 is hard; all four are undocumented, which is what makes them cost a
day instead of an hour.

### What a Mac developer could not do

**GPU transcription. At all, ever.** Not a porting gap — there is no NVIDIA device
in a Mac and Docker Desktop for Mac has no GPU passthrough. Concretely, what that
costs:

- **The two CUDA images** (`transcription-service-cuda`, `-cuda128`) cannot be
  *run*. They can be *built* — the arm64 nvidia/cuda bases exist — but building an
  image you cannot execute is only useful for catching Dockerfile breakage.
- **The GPU performance profile.** `deployment/provider_config.cuda.template.json`
  uses `model: turbo` on `device: cuda` with `job_period_ms: 500` and
  `vad_detector: true`. The CPU profile
  (`transcription_service/provider_config.template.json`) uses `job_period_ms:
  5000`, a **10× longer** cycle. So a Mac developer sees the system's latency
  characteristics wrong by an order of magnitude. Anything that is really a
  latency or backpressure question — the monitoring sidecar's period-utilization
  series, RTF thresholds, the alert rules — cannot be judged on a Mac.
- **`transcription_service/scripts/vad_bench.py`'s CUDA numbers.** The script runs
  fine on CPU torch; its GPU comparisons are simply unreproducible.
- **The `e2e:audio` flow's timings.** `tools/e2e-audio/kiosk-audio-e2e.mjs`
  hardcodes `transcriptionProviderId: 'whisper'` and defaults to
  `--stream-seconds 45` / `--session-wait-seconds 60`, tuned against the GPU
  deployment. On CPU with `job_period_ms: 5000` these need raising. The test is
  not *blocked*; its defaults are wrong for the machine.

And, importantly, what it does **not** cost:

- **No provider is lost.** All three (`debug`, `whisper-streaming`,
  `lumen-granite`) run CPU-only. `lumen-granite` is a remote HTTP provider
  (`https://lumen.ncsa.illinois.edu/v1`, `granite-speech-4.1-2b-plus`) — network
  and an API key, no local model. Both job contexts (`faster-whisper`,
  `silero-vad`) default to `device: "cpu"` in the shipped CPU template.
- **No test is lost.** `pyproject.toml` registers no custom pytest markers at all,
  and the only `skipif` gates in the Python suites are on `REDIS_URL`, not CUDA.
  No test loads a real Whisper or Silero model — the provider test deliberately
  points at `"whisper_context_tag": "no_such_whisper_context"` and asserts
  `status == "down"`; the VAD unit test uses a fake TorchScript stub.
- **No CI job is lost.** Every job in `python-ci.yml` and `python-cd.yml` is
  `ubuntu-latest`. The CUDA images are built and never run. Nothing in CI has ever
  needed a GPU.

So the honest summary of the loss: a Mac developer can build, test and run
everything, and cannot make a credible judgement about **production latency** or
validate a **CUDA base image bump**. Both are things they would hand to someone
with a GPU box anyway.

---

## Recommendation

**Worth pursuing. Cheaply, and in this order.**

The investigation's actual finding is that arm64 support is not a project — it is
a handful of small, independently useful fixes that happen to add up to Apple
Silicon support. Nothing needs porting. The dependency graph is already there.

**Smallest useful first step, and it is not about arm64 at all:** guard the NVIDIA
device reservation in `deployment/compose.yml`. It is a one-block change, it fixes
a real pre-existing bug on any GPU-less host, and it converts the Mac experience
from "the stack will not start" to "the stack starts and transcribes on CPU". Do
this whether or not anyone ever pursues arm64.

Then, in increasing order of cost:

1. Add `${{ runner.arch }}` to the `setup-node` cache key. One line, prevents a
   future landmine.
2. Add the macOS Chrome path to the three `CHROME_CANDIDATES` lists. Ten minutes.
3. Add `puppeteer_skip_download=true` to `.npmrc`. Free on every platform.
4. Write a short "developing on macOS arm64" section: macOS 14+, `CHROME_PATH`,
   the Docker socket, leave `SCRIBEAR_*_IMAGE` unset, use
   `CUDA_VARIANTS=none ./build-containers.sh`. This is where most of the actual
   value is, because every remaining friction point is undocumented rather than
   unsolved.
5. Publish multi-arch manifests for the **Node and infra images only**, via native
   `ubuntu-24.04-arm` runners and a digest-merge job. Roughly a day.
6. Add the transcription CPU image to that, once step 5's shape is settled.
7. Leave the CUDA images amd64-only. Nothing on a Mac can use them, and the arm64
   variants are only interesting for a Grace/Jetson deployment that does not exist.

Steps 1–4 cost under an hour together and remove four of the five blockers.

What would make this *not* worth pursuing: if no one on the team actually uses a
Mac. Every finding above is contingent on that demand existing — the technical
case is settled, the value case is not something this investigation can answer.

---

## What could not be determined without a build

Stated plainly so nobody mistakes analysis for verification.

**Determined by real builds** (run 30228315304, native arm64 GitHub runners):
that `node-server`, `client-webapp`, `scribear-nginx`,
`transcription-service-cpu` and `transcription-service-cuda` all build on arm64;
that the aarch64 wheel set installs *and imports*, with versions and CTranslate2
compute types captured from inside the running container; that
`make install_dev_cpu`, `make install_dev`, `make test_unit`,
`make test_integration`, `npm ci`, `npm run build` and `npm run test:unit` all
succeed on arm64; which per-platform npm binaries npm selects on arm64; the
arm64-vs-amd64 build times; and the QEMU cross-build cost (277s, 9.9× native).

**Determined without a build, but by execution** (`uv` resolution, `docker
manifest inspect`): the lockfile resolves for `aarch64-unknown-linux-gnu` and for
`aarch64-apple-darwin` on macOS 14+; the macOS 13 failure and its exact message;
base image platform support; that published GHCR images are amd64-only; that no
arm64 buildcache tag has ever existed.

**Not verified — could not be, on this hardware:**

- **Anything on actual macOS.** There is no Darwin runner in this investigation.
  The macOS claims rest on `uv sync --python-platform aarch64-apple-darwin`, which
  proves the *dependency resolution* succeeds and proves nothing about whether the
  wheels then import, whether `pytest` passes on Darwin, or whether Docker Desktop
  behaves. Job 7 used native **Linux** aarch64 as the closest available proxy.
  Verifying macOS properly needs a `macos-14` runner or a real Mac.
- **That a Mac's Docker Desktop starts the stack after the NVIDIA reservation is
  guarded.** The reservation is clearly the failure, but "remove it and the stack
  comes up" is inference. Nobody ran `docker compose up` on Apple Silicon. Neither
  the testcontainers suites nor the `e2e:audio` flow were exercised on a Mac; §4's
  claims about them come from reading the harnesses, not from running them there.
- **Whether the arm64 CUDA image is *usable* anywhere.** Job 6 proves it builds and
  that its CUDA Python stack loads. It reports `ct2 devices 0`, which any GPU-less
  runner would, so it says nothing about Grace, GH200 or Jetson. That NVIDIA's
  arm64 CUDA tags target SBSA is *(documentation)*.
- **The CTranslate2 CPU compute-type set on amd64.** The arm64 set was measured
  (`{'int8_float32', 'int8', 'float32'}`); the amd64 baseline job did not run the
  equivalent report, so the claim that arm64's set is *narrower* than amd64's is
  **not established** — only that arm64's set contains the `float32` every shipped
  config asks for. One extra step in job 4 would settle it.
- **Whether the multi-arch publishing shape in §5 works.** It was designed, not
  built. The digest-merge plumbing is the part most likely to need iteration.
- **Real transcription accuracy or throughput on Apple Silicon CPU.** No model was
  ever loaded — the test suites deliberately avoid it, and the probe did not add
  one. "Respectable CPU performance" above is an expectation, not a measurement.
  Nothing here measures how usable CPU Whisper actually is for a developer.
- **`docker manifest inspect` reports what the registry advertises**, not that the
  arm64 variant of every base image works. Five images were built for real
  (`node-server`, `client-webapp`, `scribear-nginx`, and both transcription
  images), which between them exercise `node:24.10.0`, `node-alpine3.22`,
  `nginx-alpine3.23`, `python:3.12.11-slim`, the `uv` image and `nvidia/cuda`. Not
  built: `scribear-db` (`postgres:18.3-alpine3.23`, and its pg_cron source compile
  on arm64), `scribear-redis`, and the remaining six Node services. Those rest on
  registry metadata plus the fact that their sibling images using the same bases
  did build.
