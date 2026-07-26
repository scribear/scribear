/**
 * End-to-end kiosk audio smoke test.
 *
 * Launches headless Chromium against a running ScribeAR compose stack,
 * activates a kiosk device, unmutes the microphone (fake-audio source),
 * creates an on-demand session, and asserts that transcripts appear in
 * the kiosk page — proving the full audio path works:
 *
 *   Chromium /kiosk → AudioWorklet → SAFP → node-server →
 *   transcription-service → whisper → transcripts back to kiosk UI
 *
 * Prerequisites:
 *   - The compose stack is up and healthy (`docker compose up -d`).
 *   - Chrome/Chromium is installed (or CHROME_PATH is set).
 *   - `deployment/.env` exists with ORIGIN, SESSION_MANAGER_API_KEY, etc.
 *
 * Usage:
 *   node tools/e2e/kiosk-audio-e2e.mjs
 *
 * Exit code 0 = success (transcripts detected), 1 = failure/timeout.
 *
 * The test registers its own device + room + session, so it can run
 * repeatedly without state leaking between runs. The activation code has
 * a 5-minute TTL, so the entire test must complete within that window.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// --- Configuration ---------------------------------------------------------

const ENV_FILE = join(REPO_ROOT, 'deployment', '.env');
const AUDIO_FILE = join(
  REPO_ROOT,
  'test_audio_files',
  'speech',
  'harvard_16k_mono.wav',
);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/home/angrave/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

// Harvard-sentence words that appear in the first ~30s of the fixture.
// The canary uses the same fixture and produces the same transcripts.
const TRANSCRIPT_MARKERS = [
  'rice',
  'lemon',
  'chicken',
  'bowls',
  'planks',
  'glue',
  'well',
  'depth',
  'dark',
  'blue',
  'sheet',
  'rare',
  'dish',
];

// --- Helpers ---------------------------------------------------------------

function log(msg) {
  console.log(`[kiosk-e2e ${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    `No Chrome/Chromium found. Set CHROME_PATH. Tried: ${CHROME_CANDIDATES.join(', ')}`,
  );
}

/**
 * Parse the .env file into a plain object. The deployment scripts `source`
 * it, so we do the same here rather than depending on a dotenv lib.
 */
function loadEnv() {
  const content = readFileSync(ENV_FILE, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    let val = trimmed.slice(eq + 1);
    // Strip surrounding quotes.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

/**
 * Register a device, create a room, and return the activation code + room UID.
 * Uses curl against the session-manager API (same as the deployment scripts).
 */
function registerDeviceAndRoom(env) {
  const origin = env.ORIGIN;
  const apiKey = env.SESSION_MANAGER_API_KEY;
  const certFlag = env.SSL_CERT_PATH
    ? `--cacert ${env.SSL_CERT_PATH}`
    : '--insecure';

  log('Registering e2e test device...');
  const reg = JSON.parse(
    execSync(
      `curl -s ${certFlag} -X POST '${origin}/api/session-manager/v1/device-management/register-device' ` +
        `-H 'Content-Type: application/json' -H 'Authorization: Bearer ${apiKey}' ` +
        `-d '{"name": "e2e-kiosk-test"}'`,
    ),
  );
  log(`  deviceUid=${reg.deviceUid}  code=${reg.activationCode}`);

  log('Creating e2e test room...');
  const room = JSON.parse(
    execSync(
      `curl -s ${certFlag} -X POST '${origin}/api/session-manager/v1/room-management/create-room' ` +
        `-H 'Content-Type: application/json' -H 'Authorization: Bearer ${apiKey}' ` +
        `-d '{"name": "e2e-test-room", "timezone": "UTC", "autoSessionEnabled": false, "sourceDeviceUids": ["${reg.deviceUid}"]}'`,
    ),
  );
  log(`  roomUid=${room.uid}`);

  return { activationCode: reg.activationCode, roomUid: room.uid };
}

/**
 * Create an on-demand session in the room (whisper provider).
 */
function createSession(env, roomUid) {
  const origin = env.ORIGIN;
  const apiKey = env.SESSION_MANAGER_API_KEY;
  const certFlag = env.SSL_CERT_PATH
    ? `--cacert ${env.SSL_CERT_PATH}`
    : '--insecure';

  const body = JSON.stringify({
    roomUid,
    name: 'e2e-test-session',
    joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
  });
  const result = JSON.parse(
    execSync(
      `curl -s ${certFlag} -X POST '${origin}/api/session-manager/v1/schedule-management/create-on-demand-session' ` +
        `-H 'Content-Type: application/json' -H 'Authorization: Bearer ${apiKey}' ` +
        `-d '${body.replace(/'/g, "'\\''")}'`,
    ),
  );
  log(`Created session: ${result.uid}`);
  return result.uid;
}

// --- Main ------------------------------------------------------------------

async function main() {
  const env = loadEnv();
  const origin = env.ORIGIN;
  if (!origin) throw new Error('ORIGIN not set in deployment/.env');

  const { activationCode, roomUid } = registerDeviceAndRoom(env);
  const chromePath = resolveChrome();
  log(`Launching Chrome: ${chromePath}`);
  log(`Fake audio: ${AUDIO_FILE}`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
    acceptInsecureCerts: true,
  });

  try {
    const page = await browser.newPage();

    // Pre-grant microphone permission so the INFO_PROMPT path is never entered.
    const client = await page.target().createCDPSession();
    await client.send('Browser.grantPermissions', {
      permissions: ['audioCapture'],
      origin,
    });
    log('Pre-granted audioCapture permission');

    page.on('console', (msg) => {
      if (msg.type() === 'error') log(`[browser console.error] ${msg.text()}`);
    });
    page.on('pageerror', (err) => log(`[browser pageerror] ${err.message}`));

    // --- Step 1: Load kiosk and activate ---
    log(`Navigating to ${origin}/kiosk/`);
    await page.goto(`${origin}/kiosk/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input', { timeout: 10_000 });
    log('Activation form visible');

    await page.type('input', activationCode);
    log(`Typed activation code: ${activationCode}`);

    const activateBtn = await page.evaluateHandle(() => {
      const btns = [...document.querySelectorAll('button')];
      return btns.find((b) => b.textContent?.includes('Activate')) ?? null;
    });
    if (!(await activateBtn.asElement()))
      throw new Error('Activate button not found');
    await activateBtn.asElement().click();
    log('Clicked Activate');

    await sleep(3000);

    // --- Step 2: Unmute the microphone ---
    log('Looking for Unmute Microphone button...');
    let unmuted = false;
    for (let i = 0; i < 10; i++) {
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector(
          'button[aria-label="Unmute Microphone"]',
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        unmuted = true;
        log('Clicked Unmute Microphone');
        break;
      }
      await sleep(500);
    }
    if (!unmuted) throw new Error('Unmute Microphone button not found');

    await sleep(2000);
    log('Mic should now be ACTIVE');

    // --- Step 3: Create the on-demand session ---
    log('Creating on-demand session...');
    createSession(env, roomUid);

    // --- Step 4: Watch for transcripts ---
    log('Watching for transcripts in kiosk page...');

    let lastSnippet = '';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const text = await page.evaluate(() =>
        document.body.innerText.toLowerCase(),
      );

      if (text !== lastSnippet) {
        log(`Page text changed: ${text.slice(0, 200)}`);
        lastSnippet = text;
      }

      if (TRANSCRIPT_MARKERS.some((w) => text.includes(w))) {
        log('*** SUCCESS: transcript detected in kiosk page ***');
        log(`Snippet: ${lastSnippet.slice(0, 300)}`);
        process.exit(0);
      }

      await sleep(2000);
    }

    log('FAILURE: no transcripts detected within 90s.');
    log(`Final page text: ${lastSnippet.slice(0, 500)}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  if (err.stack) log(err.stack);
  process.exit(1);
});
