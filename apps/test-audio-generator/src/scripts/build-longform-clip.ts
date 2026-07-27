import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AppConfig } from '#src/app-config/app-config.js';
import { buildLongformWav } from '#src/server/shared/clips/longform.js';

/**
 * Builds the `longform` clip into the image, at image-build time.
 *
 * Run by the Dockerfile so the clip is already on disk when the container
 * starts. It is not required: `ClipCatalogService` builds the clip on first use
 * if this never ran, and that path is what a local `npm run dev` takes. Doing
 * it here is only about who waits — the build machine, or the first operator to
 * select the clip.
 *
 * Exits 0 whether the download worked or not, printing which source it used. A
 * build host with no egress is a normal case, not a failure: the fixtures
 * always produce a serviceable clip. It exits non-zero only if it could not
 * produce a clip at all, which means the committed fixtures are missing and the
 * image would be broken anyway.
 */
async function main() {
  // `AppConfig` requires the three server variables, and nothing here listens.
  // Defaulted rather than passed in by the Dockerfile so that the clip's
  // configuration — paths, source URL, target length — stays in exactly one
  // place, read the same way here as at runtime.
  process.env['LOG_LEVEL'] ??= 'silent';
  process.env['PORT'] ??= '0';
  process.env['HOST'] ??= '127.0.0.1';
  // Likewise: the service key guards the control API, and there is no control
  // API in a build step. `AppConfig` does not validate it — `ServiceAuthService`
  // does, at server construction — so nothing needs to be invented here.

  const config = new AppConfig();
  const { clipPaths, longform } = config.clipCatalogConfig;
  const path = clipPaths.longform;

  const result = await buildLongformWav(longform);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, result.wav);

  process.stdout.write(
    `longform clip: ${String(result.wav.length)} bytes at ${path} (${result.source}) - ${result.note}\n`,
  );
}

await main();
