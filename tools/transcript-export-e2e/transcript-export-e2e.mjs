/**
 * Transcript / summary export end-to-end check, in real Chrome.
 *
 * Usage:
 *   node tools/transcript-export-e2e/transcript-export-e2e.mjs [options]
 *
 * Options:
 *   --profile <dir>        Chrome profile dir, persisted so the ~1.8 GB model
 *                          survives between runs
 *                          (default: ~/.cache/scribear-transcript-export-e2e)
 *   --download-dir <dir>   where downloads land (default: a temp dir)
 *   --summary-timeout <n>  seconds to wait for a summary, including the model
 *                          download (default: 900)
 *   --headful              run with a visible browser (debugging)
 *   --json                 machine-readable result on stdout
 *
 * Why this exists
 * ---------------
 * Two things here cannot be checked anywhere but a real browser.
 *
 * **A download is not a function call.** `downloadTextFile` builds a `Blob`,
 * mints an object URL, clicks a detached anchor and revokes the URL later. Unit
 * tests stub every one of those. Whether a file with the right name and the
 * right bytes actually lands on disk is only answerable by watching a real
 * Chrome write one - including the revoke timing, which if done synchronously
 * cancels the download it just started.
 *
 * **Summarization availability is a property of the machine.** `Summarizer`
 * exists as an object on hardware that cannot host Gemini Nano; there
 * `availability()` answers `'unavailable'` and every `create()` fails with
 * "Unable to create a text session because the service is not running". So the
 * summary checks are conditional by design: on a capable machine they run the
 * real model, and on one that cannot they assert the *withholding* - that the
 * service reports itself unsupported rather than offering something that can
 * only fail. Both outcomes are a pass; a summary offered on a machine that
 * cannot deliver it is the failure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const HARNESS_DIR = join(__dirname, 'harness');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/**
 * A transcript big enough to force the recursive path: comfortably more than
 * one 12,000-character section, so the run has to summarize sections and then
 * summarize their summaries.
 */
const LONG_TRANSCRIPT = buildTranscript(30_000);

function buildTranscript(chars) {
  const sentences = [
    'Good morning everyone and welcome back to the operating systems lecture.',
    'Today we are going to look at how the scheduler decides which process runs next.',
    'A process is an instance of a running program together with its own address space.',
    'When a process blocks on input or output the scheduler picks another runnable process.',
    'Virtual memory lets each process behave as though it owns the whole address space.',
    'The page table maps virtual pages onto the physical frames that actually hold them.',
    'A page fault happens when a program touches a page that is not currently resident.',
    'File systems arrange blocks on a disk so that a name can be turned into data.',
  ];
  let text = '';
  let i = 0;
  while (text.length < chars) {
    text += `${sentences[i % sentences.length]} `;
    i += 1;
    if (i % 8 === 0) text += '\n\n';
  }
  return text.slice(0, chars);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(id, name, ok, detail = '') {
  return { id, name, ok, detail };
}

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
    profile: join(homedir(), '.cache', 'scribear-transcript-export-e2e'),
    downloadDir: mkdtempSync(join(tmpdir(), 'scribear-export-')),
    summaryTimeout: 900,
    headful: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--json') a.json = true;
    else if (f === '--headful') a.headful = true;
    else if (f === '--profile') a.profile = argv[++i];
    else if (f === '--download-dir') a.downloadDir = argv[++i];
    else if (f === '--summary-timeout') a.summaryTimeout = Number(argv[++i]);
    else throw new Error(`Unknown option: ${f}`);
  }
  return a;
}

function buildHarness(log) {
  execFileSync(
    join(REPO_ROOT, 'node_modules', '.bin', 'esbuild'),
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
 * The on-device model APIs are only exposed on localhost when these labs are
 * enabled, and the only way to set them without a human in `chrome://flags` is
 * to write the profile's `Local State` before launch.
 */
function enableOnDeviceModelFlags(profileDir) {
  mkdirSync(profileDir, { recursive: true });
  const path = join(profileDir, 'Local State');
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  state.browser = state.browser ?? {};
  state.browser.enabled_labs_experiments = [
    'optimization-guide-on-device-model@1',
    'prompt-api-for-gemini-nano@1',
  ];
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function serveHarness() {
  const server = createServer((req, res) => {
    // Strip the query before choosing a file: `/?stub=1` is a request for
    // index.html, and joining the raw path yields the directory itself.
    const path = (req.url ?? '/').replace(/[?#].*$/, '');
    const file = join(HARNESS_DIR, path === '/' ? '/index.html' : path);
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

/** Files in the download dir, ignoring Chrome's in-progress `.crdownload`. */
function completedDownloads(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.endsWith('.crdownload'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.json
    ? () => {}
    : (m) => {
        console.log(m);
      };
  const results = [];

  buildHarness(log);
  enableOnDeviceModelFlags(args.profile);
  mkdirSync(args.downloadDir, { recursive: true });
  const { server, port } = await serveHarness();
  log(`  harness at http://localhost:${port}/`);
  log(`  downloads to ${args.downloadDir}`);

  const browser = await puppeteer.launch({
    executablePath: resolveChrome(),
    headless: !args.headful,
    userDataDir: args.profile,
    ignoreDefaultArgs: [
      '--enable-automation',
      '--disable-features',
      '--disable-background-networking',
      '--disable-component-update',
    ],
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--enable-features=SummarizationAPI,AIPromptAPI,OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel,OptimizationGuideOnDeviceModelPerformanceParams',
    ],
  });

  try {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: args.downloadDir,
    });

    await page.goto(`http://localhost:${port}/`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('#ready[data-ready="true"]');
    await page.evaluate((text) => {
      window.__harness.setTranscript(text);
    }, LONG_TRANSCRIPT);

    // --- The transcript actually reaches the disk ----------------------
    await page.click('#save-transcript');
    const transcriptFile = await until(() => {
      const files = completedDownloads(args.downloadDir).filter((n) =>
        n.startsWith('transcript-'),
      );
      return files[0] ?? null;
    }, 20_000);

    results.push(
      check(
        'transcript-downloads',
        'the transcript is saved as transcript-YYYYMMDD-HHMMSS.txt',
        transcriptFile !== null &&
          /^transcript-\d{8}-\d{6}\.txt$/.test(transcriptFile),
        transcriptFile ?? 'no file appeared within 20s',
      ),
    );

    if (transcriptFile) {
      // The revoke is deferred by a minute precisely so it cannot cancel the
      // download it just started; a truncated file here is what that guards.
      const contents = readFileSync(
        join(args.downloadDir, transcriptFile),
        'utf8',
      );
      results.push(
        check(
          'transcript-content-intact',
          'the saved transcript holds the whole transcript and nothing else',
          contents.trim() === LONG_TRANSCRIPT.trim() &&
            contents.startsWith('Good morning everyone'),
          `${contents.length.toString()} of ${LONG_TRANSCRIPT.length.toString()} chars`,
        ),
      );
    }

    // --- Summarization: capability first -------------------------------
    const apiPresent = await page.evaluate(() =>
      window.__harness.isApiPresent(),
    );
    const availability = await page.evaluate(() =>
      window.__harness.checkAvailability(),
    );
    log(`  Summarizer API present=${String(apiPresent)} availability=${availability}`);

    const canSummarize =
      availability === 'available' ||
      availability === 'downloadable' ||
      availability === 'downloading';

    if (!canSummarize) {
      // Not a skip: this is the branch most users are on, and getting it wrong
      // means offering a button that can only fail.
      const state = await page.evaluate(() => window.__harness.state);
      results.push(
        check(
          'unusable-model-is-withheld',
          'a device that cannot run the model reports summarization as unsupported',
          state.status === 'UNSUPPORTED',
          `API present=${String(apiPresent)}, availability=${availability}, status=${state.status}`,
        ),
      );
      log(
        '  NOTE: this machine cannot run Gemini Nano, so the real summary checks did not run.',
      );
    } else {
      const state = await page.evaluate(() => window.__harness.state);
      results.push(
        check(
          'usable-model-is-offered',
          'a device that can run the model offers summarization',
          state.status !== 'UNSUPPORTED',
          `availability=${availability}, status=${state.status}`,
        ),
      );

      log('  running a real on-device summary (may take minutes on first use)...');
      await page.click('#summarize');
      const run = await until(
        async () =>
          (await page.evaluate(() => window.__harness.done))
            ? page.evaluate(() => window.__harness.lastRun)
            : null,
        args.summaryTimeout * 1000,
        2000,
      );

      results.push(
        check(
          'summarizes-long-transcript',
          'a transcript larger than one request is summarized',
          run !== null && run.result.text.trim().length > 0,
          run
            ? `${run.result.sectionCount.toString()} sections, ${run.result.passes.toString()} pass(es)`
            : 'no summary within the timeout',
        ),
      );

      if (run) {
        results.push(
          check(
            'recursive-reduction-happened',
            'the transcript was split into sections and the summaries combined',
            run.result.sectionCount > 1,
            `sectionCount=${run.result.sectionCount.toString()}`,
          ),
        );
        results.push(
          check(
            'summary-is-shorter-than-source',
            'the summary is substantially shorter than the transcript',
            run.result.text.length < LONG_TRANSCRIPT.length / 2,
            `${run.result.text.length.toString()} vs ${LONG_TRANSCRIPT.length.toString()} chars`,
          ),
        );
        results.push(
          check(
            'summary-file-states-local-generation',
            'the saved summary says it was generated locally, before its content',
            run.fileText.includes('GENERATED LOCALLY, IN YOUR BROWSER.') &&
              run.fileText.indexOf('GENERATED LOCALLY') <
                run.fileText.indexOf(run.result.text.trim().slice(0, 40)),
            '',
          ),
        );

        const summaryFile = await until(() => {
          const files = completedDownloads(args.downloadDir).filter((n) =>
            n.startsWith('summary-'),
          );
          return files[0] ?? null;
        }, 20_000);
        results.push(
          check(
            'summary-downloads',
            'the summary is saved as summary-YYYYMMDD-HHMMSS.txt',
            summaryFile !== null &&
              /^summary-\d{8}-\d{6}\.txt$/.test(summaryFile),
            summaryFile ?? 'no file appeared within 20s',
          ),
        );
      }
    }

    // --- The recursive path, in a real browser --------------------------
    // Runs with a stand-in model so the reduction, the file builder and the
    // real download are exercised even where Gemini Nano cannot run. Named
    // "stubbed-model" so nobody mistakes it for a test of the model itself.
    const stubPage = await browser.newPage();
    const stubCdp = await stubPage.createCDPSession();
    await stubCdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: args.downloadDir,
    });
    await stubPage.goto(`http://localhost:${port.toString()}/?stub=1`, {
      waitUntil: 'domcontentloaded',
    });
    await stubPage.waitForSelector('#ready[data-ready="true"]');
    await stubPage.evaluate((text) => {
      window.__harness.setTranscript(text);
    }, LONG_TRANSCRIPT);
    await stubPage.click('#summarize');

    const stubRun = await until(
      async () =>
        (await stubPage.evaluate(() => window.__harness.done))
          ? stubPage.evaluate(() => window.__harness.lastRun)
          : null,
      120_000,
      500,
    );

    results.push(
      check(
        'stubbed-model-recursive-reduction',
        'the recursive reduction runs in a real browser and produces a summary',
        stubRun !== null &&
          stubRun.result.sectionCount > 1 &&
          stubRun.result.text.trim().length > 0,
        stubRun
          ? `${stubRun.result.sectionCount.toString()} sections, ${stubRun.result.passes.toString()} pass(es), converged=${String(stubRun.result.converged)}`
          : 'no summary within 120s',
      ),
    );

    const stubSummaryFile = await until(() => {
      const files = completedDownloads(args.downloadDir).filter((n) =>
        n.startsWith('summary-'),
      );
      return files[0] ?? null;
    }, 20_000);
    results.push(
      check(
        'stubbed-model-summary-downloads',
        'the summary file reaches the disk, named summary-YYYYMMDD-HHMMSS.txt',
        stubSummaryFile !== null &&
          /^summary-\d{8}-\d{6}\.txt$/.test(stubSummaryFile),
        stubSummaryFile ?? 'no file appeared within 20s',
      ),
    );

    if (stubSummaryFile) {
      const saved = readFileSync(
        join(args.downloadDir, stubSummaryFile),
        'utf8',
      );
      results.push(
        check(
          'saved-summary-states-local-generation',
          'the file on disk says, before its content, that it was made locally',
          saved.includes('GENERATED LOCALLY, IN YOUR BROWSER.') &&
            saved.includes('was not uploaded') &&
            saved.indexOf('GENERATED LOCALLY') < saved.indexOf('- Good morning'),
          saved.split('\n')[0] ?? '',
        ),
      );
    }

    // --- Nothing escaped into the page ---------------------------------
    const stubErrors = await stubPage.evaluate(
      () => window.__harness.pageErrors,
    );
    const pageErrors = [
      ...(await page.evaluate(() => window.__harness.pageErrors)),
      ...stubErrors,
    ];
    results.push(
      check(
        'no-uncaught-errors',
        'no exception or unhandled rejection escaped to the page',
        pageErrors.length === 0,
        pageErrors.join(' | '),
      ),
    );

    return { results, canSummarize };
  } finally {
    await browser.close();
    server.close();
  }
}

main()
  .then(({ results, canSummarize }) => {
    const failed = results.filter((r) => !r.ok);
    if (process.argv.includes('--json')) {
      console.log(
        JSON.stringify(
          { ok: failed.length === 0, summarizerUsable: canSummarize, results },
          null,
          2,
        ),
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
      if (!canSummarize) {
        console.log(
          '  The summary checks that need Gemini Nano did not run on this machine.',
        );
      }
    }
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(`\n  ERROR: ${error.message}`);
    process.exit(1);
  });
