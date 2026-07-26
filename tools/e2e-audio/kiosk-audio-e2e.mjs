/**
 * End-to-end audio check: does a real Chromium kiosk get audio all the way to a
 * transcription provider, and does it stay working after the upstream restarts?
 *
 * Usage:
 *   node tools/e2e-audio/kiosk-audio-e2e.mjs --activation-code <CODE> [options]
 *
 * Options:
 *   --base-url <url>       default https://localhost
 *   --stream-seconds <n>   default 45   how long to stream before scoring
 *   --restart-cmd <cmd>    shell command that restarts the transcription
 *                          service. When given, it runs mid-stream and the run
 *                          only passes if transcripts resume afterwards.
 *   --json                 machine-readable result on stdout
 *
 * Why this exists: the kiosk is the app the product depends on for audio
 * capture and it has no test suite of its own, so the audio path was only ever
 * exercised by hand. The failure this was written for was invisible to every
 * other check - the kiosk stayed connected, node-server kept accepting frames,
 * and audio silently stopped reaching a provider after the first upstream blip
 * because credentials were sent once per session instead of once per
 * connection. Nothing short of driving the real browser and then breaking the
 * upstream underneath it catches that.
 *
 * Requires a running stack (deployment/compose.yml) and a registered source
 * device whose room has an active session. Chrome is auto-detected from
 * CHROME_PATH, then the usual system locations.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

/** Speech fixture played into Chrome's fake microphone. */
const WAV = join(
  __dirname,
  '..',
  '..',
  'test_audio_files',
  'speech',
  'harvard_16k_mono.wav',
);

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    `No Chrome/Chromium found. Set CHROME_PATH. Tried: ${CHROME_CANDIDATES.join(', ')}`,
  );
}

function parseArgs(argv) {
  const args = {
    baseUrl: 'https://localhost',
    streamSeconds: 45,
    activationCode: '',
    restartCmd: '',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--base-url') args.baseUrl = argv[++i];
    else if (flag === '--stream-seconds')
      args.streamSeconds = Number(argv[++i]);
    else if (flag === '--activation-code') args.activationCode = argv[++i];
    else if (flag === '--restart-cmd') args.restartCmd = argv[++i];
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Click the first visible control whose text or aria-label contains `needle`. */
function clickByText(page, needle) {
  return page.evaluate((text) => {
    const els = [...document.querySelectorAll('button, [role="button"], a')];
    const hit = els.find(
      (el) =>
        (el.textContent ?? '').trim().toLowerCase().includes(text) ||
        (el.getAttribute('aria-label') ?? '').toLowerCase().includes(text),
    );
    if (!hit) return false;
    hit.click();
    return true;
  }, needle.toLowerCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (...m) => {
    if (!args.json) console.log(...m);
  };

  const browser = await puppeteer.launch({
    executablePath: resolveChrome(),
    headless: true,
    acceptInsecureCerts: true,
    // A fresh profile per run would burn a device activation code every time
    // (they are single-use), so the DEVICE_TOKEN cookie needs somewhere to live
    // for the duration of the run at least.
    userDataDir: mkdtempSync(join(tmpdir(), 'scribear-e2e-')),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  // Pre-grant the microphone. Without this the service stops at INFO_PROMPT and
  // waits for a second activation call, which reads as "connected but silent" -
  // the same symptom as a genuine audio fault.
  await browser
    .defaultBrowserContext()
    .overridePermissions(args.baseUrl, ['microphone']);

  const page = await browser.newPage();
  let binaryFrames = 0;
  const transcripts = [];

  let sourceSocketOpen = false;

  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', (e) => {
    if (e.url.includes('/transcription-stream/')) sourceSocketOpen = true;
  });
  cdp.on('Network.webSocketFrameSent', (e) => {
    if (e.response.opcode === 2) binaryFrames++;
  });
  cdp.on('Network.webSocketFrameReceived', (e) => {
    if (e.response.opcode !== 1) return;
    if (e.response.payloadData.includes('"type":"transcript"')) {
      transcripts.push(Date.now());
    }
  });

  log('--- opening /kiosk');
  await page.goto(`${args.baseUrl}/kiosk`, {
    waitUntil: 'networkidle2',
    timeout: 60000,
  });

  if (
    await page.evaluate(() =>
      document.body.innerText.includes('not registered'),
    )
  ) {
    if (!args.activationCode) {
      throw new Error(
        'Device is unregistered and no --activation-code was supplied.',
      );
    }
    log('--- activating device');
    await page.type('input', args.activationCode);
    await clickByText(page, 'activate');
    await sleep(4000);
  }

  // Wait for the kiosk to join its session first. Audio only reaches the wire
  // through the session socket, so toggling the mic before the socket exists
  // would flip it on with nothing to measure, and the click-and-verify loop
  // below would then toggle it back off looking for frames that could not
  // arrive yet.
  log('--- waiting for the session socket');
  for (let waited = 0; waited < 60 && !sourceSocketOpen; waited += 2) {
    await sleep(2000);
  }
  if (!sourceSocketOpen) {
    throw new Error(
      'Kiosk never opened a transcription-stream socket - is a session active in its room?',
    );
  }

  // The microphone control is a TOGGLE, so a fixed number of clicks is a coin
  // flip. Click, then confirm audio is actually on the wire before continuing.
  log('--- enabling microphone');
  let streaming = false;
  for (let attempt = 1; attempt <= 4 && !streaming; attempt++) {
    const before = binaryFrames;
    await clickByText(page, 'microphone');
    await sleep(4000);
    streaming = binaryFrames > before + 5;
    log(`    attempt ${attempt}: frames ${before} -> ${binaryFrames}`);
  }
  if (!streaming) {
    throw new Error(
      'Microphone never started streaming - no binary frames left the browser.',
    );
  }

  const half = Math.floor(args.streamSeconds / 2);
  log(`--- streaming ${half}s before the restart`);
  await sleep(half * 1000);

  let restartAtMs = null;
  if (args.restartCmd) {
    log(`--- restarting upstream: ${args.restartCmd}`);
    restartAtMs = Date.now();
    execSync(args.restartCmd, { stdio: args.json ? 'ignore' : 'inherit' });
  }

  log(`--- streaming ${args.streamSeconds - half}s after the restart`);
  const framesBeforeTail = binaryFrames;
  await sleep((args.streamSeconds - half) * 1000);

  const after = restartAtMs
    ? transcripts.filter((t) => t > restartAtMs).length
    : transcripts.length;
  const before = restartAtMs
    ? transcripts.filter((t) => t <= restartAtMs).length
    : 0;

  const failures = [];
  if (binaryFrames <= framesBeforeTail) {
    failures.push('the browser stopped sending audio');
  }
  if (transcripts.length === 0) {
    failures.push('no transcripts ever arrived');
  }
  // The regression this exists for: transcripts before the restart, none after.
  if (restartAtMs && after === 0) {
    failures.push(
      'no transcripts after the upstream restart (session did not recover)',
    );
  }

  const result = {
    ok: failures.length === 0,
    binaryFrames,
    transcripts: transcripts.length,
    transcriptsBeforeRestart: restartAtMs ? before : null,
    transcriptsAfterRestart: restartAtMs ? after : null,
    failures,
  };

  await browser.close();

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\n=== RESULT ===');
    console.log(`binary frames sent : ${result.binaryFrames}`);
    console.log(`transcripts        : ${result.transcripts}`);
    if (restartAtMs) {
      console.log(`  before restart   : ${before}`);
      console.log(`  after restart    : ${after}`);
    }
    console.log(result.ok ? '\nPASS' : `\nFAIL\n - ${failures.join('\n - ')}`);
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
