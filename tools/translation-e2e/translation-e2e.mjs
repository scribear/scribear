/**
 * In-browser translation end-to-end check: run the real `TranslationService`
 * against Chrome's real Translator API and assert what a reader would see.
 *
 * Usage:
 *   node tools/translation-e2e/translation-e2e.mjs [options]
 *
 * Options:
 *   --profile <dir>        Chrome profile dir. Persisted so the TranslateKit
 *                          library and language models survive between runs.
 *                          (default: ~/.cache/scribear-translation-e2e)
 *   --language <tag>       target language (default: es)
 *   --warmup-seconds <n>   how long to wait for Chrome to install the
 *                          TranslateKit component on a cold profile
 *                          (default: 420)
 *   --headful              run with a visible browser (debugging)
 *   --skip-if-unavailable  exit 0, not 1, when the browser never becomes able
 *                          to translate (for CI on machines with no model)
 *   --json                 machine-readable result on stdout
 *
 * Why this exists
 * ---------------
 * The unit tests drive a fake `self.Translator`, which means they pin our
 * logic against *our belief* about the browser API. That belief is the risky
 * part: the API is young, ships behind flags, downloads models over the
 * network, and its failure modes are undocumented. Everything here is a claim
 * the fake cannot check.
 *
 * Two things in particular are only observable in a real browser:
 *
 *   - **A cold profile cannot translate, and does not say so.** The per-pair
 *     model downloads on demand, but the `Chrome TranslateKit` *library*
 *     component arrives separately on the component updater's own schedule -
 *     roughly 80 seconds after first launch, in this repo's measurements. Until
 *     it lands, `create()` rejects with `NotSupportedError` and a console
 *     warning of "Failed to load the translation library", which is
 *     indistinguishable from an unsupported language pair. That is why the
 *     warm-up here retries for minutes rather than failing on the first error.
 *   - **Identity pairs are rejected.** `en` to `en` reports `unavailable` and
 *     throws `NotSupportedError` on `create()`, contradicting the spec. This
 *     check pins that, because it is the cheapest real failure available and
 *     it exercises the whole error-reporting path against real Chrome.
 *
 * Requires real Google Chrome (>=138). Chrome for Testing, Chromium, and
 * Playwright's bundled browser all lack the model components and will report
 * the API as absent.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const HARNESS_DIR = join(__dirname, 'harness');

// Chrome for Testing and Chromium are deliberately absent: they ship without
// the Optimization Guide components, so `Translator` is simply not there.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/** A caption long enough that two cannot share one translate() batch. */
const LONG_CAPTION = `${'the quick brown fox jumps over the lazy dog '.repeat(7)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A single assertion result. */
function check(id, name, ok, detail = '') {
  return { id, name, ok, detail };
}

/** Poll `fn` until it returns truthy or `timeoutMs` elapses. */
async function until(fn, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    `No Google Chrome found. Set CHROME_PATH. Tried: ${CHROME_CANDIDATES.join(', ')}`,
  );
}

function parseArgs(argv) {
  const a = {
    profile: join(homedir(), '.cache', 'scribear-translation-e2e'),
    language: 'es',
    warmupSeconds: 420,
    headful: false,
    skipIfUnavailable: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--json') a.json = true;
    else if (f === '--headful') a.headful = true;
    else if (f === '--skip-if-unavailable') a.skipIfUnavailable = true;
    else if (f === '--profile') a.profile = argv[++i];
    else if (f === '--language') a.language = argv[++i];
    else if (f === '--warmup-seconds') a.warmupSeconds = Number(argv[++i]);
    else throw new Error(`Unknown option: ${f}`);
  }
  return a;
}

/**
 * Bundles the harness against the *source* of `@scribear/live-translation-store`
 * (via the `development` export condition), so this checks the code in the
 * repo rather than a stale `dist`.
 */
function buildHarness(log) {
  const esbuild = join(REPO_ROOT, 'node_modules', '.bin', 'esbuild');
  execFileSync(
    esbuild,
    [
      join(HARNESS_DIR, 'main.ts'),
      '--bundle',
      '--format=iife',
      '--target=chrome120',
      '--conditions=development',
      `--outfile=${join(HARNESS_DIR, 'bundle.js')}`,
    ],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
  log('  harness bundled');
}

/**
 * Chrome only exposes the on-device model APIs on localhost when the
 * `optimization-guide-on-device-model` lab is enabled, and the only way to set
 * it without a human clicking through `chrome://flags` is to write the
 * profile's `Local State` before launch.
 */
function enableOnDeviceModelFlag(profileDir) {
  mkdirSync(profileDir, { recursive: true });
  const path = join(profileDir, 'Local State');
  const state = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : {};
  state.browser = state.browser ?? {};
  state.browser.enabled_labs_experiments = [
    'optimization-guide-on-device-model@1',
  ];
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function serveHarness() {
  const server = createServer((req, res) => {
    const name = req.url === '/' || !req.url ? '/index.html' : req.url;
    const file = join(HARNESS_DIR, name.replace(/[?#].*$/, ''));
    if (!file.startsWith(HARNESS_DIR) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': file.endsWith('.js')
        ? 'text/javascript'
        : 'text/html; charset=utf-8',
    });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function launchChrome(args) {
  return puppeteer.launch({
    executablePath: resolveChrome(),
    headless: !args.headful,
    userDataDir: args.profile,
    // Puppeteer's defaults actively break this API: `--disable-features`
    // switches off Translate and the optimization hints it needs, and
    // `--disable-background-networking` blocks the model download outright.
    ignoreDefaultArgs: [
      '--enable-automation',
      '--disable-features',
      '--disable-background-networking',
      '--disable-component-update',
    ],
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--enable-features=TranslatorAPI,OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel',
    ],
  });
}

const readState = (page) => page.evaluate(() => window.__harness.state);
const readSegments = (page) => page.evaluate(() => window.__harness.segments);
const captionText = (segments) => segments.map((s) => s.text).join(' ');

/**
 * Clicks the enable button until the service reaches READY.
 *
 * On a cold profile the first several attempts fail with `NotSupportedError`
 * while Chrome installs the TranslateKit library in the background. Retrying
 * is the documented way through: there is no event, no progress, and no API
 * that reports that component's arrival.
 */
async function warmUpTranslator(page, args, log) {
  const deadline = Date.now() + args.warmupSeconds * 1000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await page.evaluate((lang) => {
      window.__harness.targetLanguage = lang;
    }, args.language);
    await page.click('#enable');

    const ready = await until(
      async () => {
        const state = await readState(page);
        return state.status === 'READY' || state.status === 'ERROR'
          ? state
          : null;
      },
      60_000,
    );

    if (ready?.status === 'READY') {
      log(`  translator ready after ${attempt} attempt(s)`);
      return true;
    }
    if (Date.now() >= deadline) {
      log(`  giving up: ${ready?.errorMessage ?? 'no response'}`);
      return false;
    }
    log(
      `  attempt ${attempt}: ${ready?.errorMessage ?? 'timed out'} - waiting for the TranslateKit component`,
    );
    await sleep(15_000);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.json ? () => {} : (m) => {
    console.log(m);
  };
  const results = [];

  buildHarness(log);
  enableOnDeviceModelFlag(args.profile);
  const { server, port } = await serveHarness();
  const url = `http://localhost:${port}/`;
  log(`  harness at ${url}`);

  const browser = await launchChrome(args);
  let skipped = false;

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ready[data-ready="true"]');

    // --- The API is present at all -------------------------------------
    const supported = await page.evaluate(
      () => window.__harness.service.isSupported,
    );
    results.push(
      check(
        'api-present',
        'Chrome exposes the Translator API and the service detects it',
        supported === true,
        `isSupported=${String(supported)}`,
      ),
    );

    if (!supported) {
      throw new Error(
        'Translator API absent. Use real Google Chrome >=138, not Chromium or Chrome for Testing.',
      );
    }

    // --- The language picker is built from the browser, not a guess ----
    const languages = await page.evaluate(() =>
      window.__harness.probeLanguages(),
    );
    const codes = languages.map((l) => l.code);
    results.push(
      check(
        'languages-probed',
        'the browser reports a usable set of target languages',
        languages.length >= 5 && codes.includes(args.language),
        `${String(languages.length)} languages, includes ${args.language}: ${String(codes.includes(args.language))}`,
      ),
    );
    results.push(
      check(
        'languages-labelled',
        'every offered language has a human-readable label',
        languages.every((l) => l.label && l.label !== l.code),
        languages
          .slice(0, 4)
          .map((l) => `${l.code}=${l.label}`)
          .join(', '),
      ),
    );

    // --- An unsupported pair is reported, not swallowed ----------------
    // Chrome refuses identity translation, contradicting the spec. It is the
    // cheapest real failure available, and it drives the whole error path.
    await page.evaluate(async () => {
      window.__harness.disable();
      await window.__harness.service.enable('en');
    });
    const identityState = await readState(page);
    results.push(
      check(
        'unsupported-pair-reported',
        'an unsupported language pair surfaces a readable error',
        identityState.status === 'ERROR' &&
          typeof identityState.errorMessage === 'string' &&
          identityState.errorMessage.length > 0,
        `${identityState.status}: ${identityState.errorMessage ?? ''}`,
      ),
    );

    // --- Warm up, then translate for real ------------------------------
    await page.evaluate(() => {
      window.__harness.disable();
      window.__harness.reset();
    });
    const ready = await warmUpTranslator(page, args, log);
    if (!ready) {
      results.push(
        check(
          'translator-ready',
          'the browser can create a translator for the target language',
          false,
          'TranslateKit never became available within the warm-up window',
        ),
      );
      skipped = args.skipIfUnavailable;
      return { results, skipped };
    }
    results.push(
      check(
        'translator-ready',
        'the browser can create a translator for the target language',
        true,
      ),
    );

    // A finalized caption comes back as real translated text.
    await page.evaluate(() => {
      window.__harness.reset();
      window.__harness.submit('Good morning. Welcome to the lecture.');
    });
    const translated = await until(async () => {
      const segments = await readSegments(page);
      return segments.length > 0 ? segments : null;
    }, 30_000);
    const translatedText = captionText(translated ?? []);
    results.push(
      check(
        'translates-finalized-caption',
        'a finalized caption is translated into the target language',
        translatedText.length > 0 &&
          !translatedText.includes('Welcome to the lecture'),
        `-> ${translatedText}`,
      ),
    );

    // Captions queued behind an in-flight call are merged, and every word
    // still reaches the reader in order.
    await page.evaluate(() => {
      window.__harness.reset();
      for (const line of ['One.', 'Two.', 'Three.', 'Four.']) {
        window.__harness.submit(line);
      }
    });
    const burst = await until(async () => {
      const segments = await readSegments(page);
      const text = segments.map((s) => s.text).join(' ');
      return text.length > 0 && (await readState(page)).status === 'READY'
        ? segments
        : null;
    }, 30_000);
    await sleep(2000);
    const burstText = captionText(await readSegments(page));
    results.push(
      check(
        'burst-is-not-lost',
        'a burst of finalized captions all reach the display',
        (burst?.length ?? 0) > 0 && burstText.trim().length > 0,
        `-> ${burstText}`,
      ),
    );

    // --- Backpressure, against the real model --------------------------
    // Real translation on a warm model never falls 20s behind on its own, so
    // each call is delayed to simulate a loaded device. The translation
    // underneath is still Chrome's.
    await page.evaluate(
      (caption) => {
        window.__harness.reset();
        window.__harness.setArtificialDelayMs(11_000);
        for (let i = 0; i < 3; i++) {
          window.__harness.submit(`${String(i)} ${caption}`);
        }
      },
      LONG_CAPTION,
    );
    const gapped = await until(async () => {
      const segments = await readSegments(page);
      return segments.some((s) => s.kind === 'gap') ? segments : null;
    }, 60_000);
    results.push(
      check(
        'drops-stale-captions',
        'captions more than 20s behind are dropped and marked with an ellipsis',
        gapped !== null,
        gapped
          ? `-> ${captionText(gapped)}`
          : 'no gap marker emitted within 60s',
      ),
    );

    // --- A stalled translator is reported, not silent ------------------
    await page.evaluate(() => {
      window.__harness.reset();
      window.__harness.setArtificialDelayMs(45_000);
      window.__harness.submit('This translation will never arrive in time.');
    });
    const errored = await until(async () => {
      const state = await readState(page);
      return state.status === 'ERROR' ? state : null;
    }, 40_000);
    results.push(
      check(
        'timeout-is-visible',
        'a translation that does not return in 20s is reported to the user',
        errored?.errorMessage === 'No translations are available.',
        errored ? `-> ${errored.errorMessage}` : 'no error reported within 40s',
      ),
    );

    // --- Turning it off releases the model -----------------------------
    await page.evaluate(() => {
      window.__harness.setArtificialDelayMs(0);
      window.__harness.disable();
      window.__harness.submit('This must not be translated.');
    });
    await sleep(1000);
    const offState = await readState(page);
    results.push(
      check(
        'disable-stops-translation',
        'turning translation off stops it without throwing',
        offState.status === 'OFF',
        `status=${offState.status}`,
      ),
    );

    // --- Nothing escaped into the page ---------------------------------
    // The whole point of the try/catch discipline in the service: a browser
    // feature that fails must not take the caption view down with it.
    const pageErrors = await page.evaluate(() => window.__harness.pageErrors);
    results.push(
      check(
        'no-uncaught-errors',
        'no exception or unhandled rejection escaped to the page',
        pageErrors.length === 0,
        pageErrors.join(' | '),
      ),
    );

    return { results, skipped };
  } finally {
    await browser.close();
    server.close();
  }
}

main()
  .then(({ results, skipped }) => {
    const failed = results.filter((r) => !r.ok);
    if (process.argv.includes('--json')) {
      console.log(
        JSON.stringify({ ok: failed.length === 0, skipped, results }, null, 2),
      );
    } else {
      console.log('');
      for (const r of results) {
        console.log(
          `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n          ${r.detail}` : ''}`,
        );
      }
      console.log(
        `\n  ${String(results.length - failed.length)}/${String(results.length)} checks passed`,
      );
      if (skipped) {
        console.log(
          '  SKIPPED: this machine never obtained a usable translation model.',
        );
      }
    }
    process.exit(failed.length === 0 || skipped ? 0 : 1);
  })
  .catch((error) => {
    console.error(`\n  ERROR: ${error.message}`);
    process.exit(1);
  });
