/**
 * End-to-end audio check: does a real Chromium kiosk get audio all the way to a
 * transcription provider, and does it stay working after the upstream restarts?
 *
 * Usage:
 *   node tools/e2e-audio/kiosk-audio-e2e.mjs --provision [options]
 *   node tools/e2e-audio/kiosk-audio-e2e.mjs --activation-code <CODE> [options]
 *
 * Options:
 *   --provision            register a device, room and on-demand session first,
 *                          reading the admin key from deployment/.env. Removes
 *                          the manual setup entirely; without it you must
 *                          supply --activation-code for an existing device
 *                          whose room already has an active session.
 *   --base-url <url>       default https://localhost
 *   --stream-seconds <n>   default 45   how long to stream before scoring.
 *                          Doubles as the soak length: the auto-scroll checks
 *                          below run for the whole streaming window, so
 *                          `--stream-seconds 600` is the soak invocation. There
 *                          is deliberately no separate --soak-seconds, because
 *                          the soak has nothing to measure except while audio
 *                          is streaming and transcripts are arriving.
 *   --session-wait-seconds <n>  default 60. Raise it to test a CALENDARED
 *                          session, where the kiosk must be running and idle
 *                          before the session starts.
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
 * Auto-scroll soak (see 20260831-FixAutoScroll-PLAN.md section 6.5). While
 * audio streams, nothing touches the page, so the caption view must follow the
 * speaker for the entire run. The run additionally fails if:
 *
 *   - `window.__scribearAutoScroll.transcription.userDisengagements` is not 0.
 *     Nothing clicked, scrolled or typed, so a scroll attributed to a user
 *     gesture is by definition a misattribution.
 *   - the "Jump to latest transcription" button was ever visible. That button
 *     stays mounted and is hidden with `visibility: hidden`, so presence in the
 *     DOM proves nothing - computed visibility is polled throughout streaming,
 *     because a transient appearance mid-run is exactly the reported bug.
 *
 * The viewport is resized every ~20s during streaming, alternating between a
 * landscape and a portrait size. This is not incidental: the primary suspected
 * mechanism is a resize clamping the scroll offset while new caption text
 * arrives, so a fixed-viewport soak does not exercise the bug at all.
 *
 * `suppressedDisengagements`, `lastSuppressedDistancePx` and
 * `idleReengagements` are reported but never fail the run. The first two count
 * the bug being caught and ignored - non-zero there is the fix working - and
 * the third only fires after a scrollback that this run never performs.
 *
 * Requires a running stack (deployment/compose.yml). Chrome is auto-detected
 * from CHROME_PATH, then the usual system locations.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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

/** aria-label of the control that only appears once auto-scroll has given up. */
const JUMP_BUTTON_LABEL = 'Jump to latest transcription';

/**
 * Sizes cycled through mid-stream. A landscape desktop shape and a portrait
 * tablet shape, so each resize is a large change in both axes: the suspected
 * mechanism needs the content to reflow and the scroll offset to be clamped,
 * which a few pixels of jitter would not achieve.
 */
const SOAK_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 1366 },
];

/** How often the viewport changes while streaming. */
const RESIZE_INTERVAL_MS = 20000;

/** How often the jump button's computed visibility is sampled. */
const VISIBILITY_POLL_MS = 1000;

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
    sessionWaitSeconds: 60,
    provision: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--provision') args.provision = true;
    else if (flag === '--base-url') args.baseUrl = argv[++i];
    else if (flag === '--stream-seconds')
      args.streamSeconds = Number(argv[++i]);
    else if (flag === '--session-wait-seconds')
      args.sessionWaitSeconds = Number(argv[++i]);
    else if (flag === '--activation-code') args.activationCode = argv[++i];
    else if (flag === '--restart-cmd') args.restartCmd = argv[++i];
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read `deployment/.env` for the admin key. Deliberately a plain scan rather
 * than a dotenv dependency: one key is needed and the file's own values are
 * unquoted shell-hostile strings, so `source`-ing it is worse than reading it.
 */
function loadDeploymentEnv() {
  const path = join(__dirname, '..', '..', 'deployment', '.env');
  if (!existsSync(path)) {
    throw new Error(`--provision needs ${path}, which does not exist.`);
  }
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * Register a device, put it in a fresh room as the source, and open an
 * on-demand session there. Returns the activation code.
 *
 * Worth automating rather than documenting: activation codes are single-use, so
 * the manual path burns a device per run and every failed run leaves another
 * orphan room behind.
 */
function provision(baseUrl, log) {
  const env = loadDeploymentEnv();
  const key = env.SESSION_MANAGER_API_KEY;
  if (!key) {
    throw new Error('deployment/.env has no SESSION_MANAGER_API_KEY.');
  }
  const api = `${baseUrl}/api/session-manager/v1`;
  const post = (path, body) => {
    const out = execSync(
      `curl -sk -X POST ${api}/${path} -H 'Content-Type: application/json' ` +
        `-H 'Authorization: Bearer ${key}' -d '${JSON.stringify(body)}'`,
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    if (parsed.code) {
      throw new Error(`${path} failed: ${parsed.code} ${parsed.message ?? ''}`);
    }
    return parsed;
  };

  // Unique names so repeated runs never collide on a leftover room.
  const stamp = `e2e-${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const device = post('device-management/register-device', { name: stamp });
  const room = post('room-management/create-room', {
    name: stamp,
    timezone: 'UTC',
    autoSessionEnabled: false,
    sourceDeviceUids: [device.deviceUid],
  });
  post('schedule-management/create-on-demand-session', {
    roomUid: room.uid,
    name: stamp,
    joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
  });
  log(`--- provisioned device ${device.deviceUid} in room ${room.uid}`);
  return device.activationCode;
}

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

/**
 * Whether the jump-to-bottom control is visible right now.
 *
 * The button is always in the DOM - it is hidden with `visibility: hidden` so
 * it can fade rather than pop - so `querySelector` returning something says
 * nothing. Computed style is the only honest signal, and it is read through
 * `getComputedStyle` rather than the inline style so an ancestor hiding the
 * whole region also reads as hidden.
 */
function isJumpButtonVisible(page) {
  return page.evaluate((label) => {
    const buttons = [...document.querySelectorAll(`[aria-label="${label}"]`)];
    return buttons.some((el) => {
      const style = getComputedStyle(el);
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0
      );
    });
  }, JUMP_BUTTON_LABEL);
}

/** Counters published by the transcript region's auto-scroll hook, or null. */
function readAutoScrollDiagnostics(page) {
  return page.evaluate(() => {
    const entry = window.__scribearAutoScroll?.transcription;
    return entry ? { ...entry } : null;
  });
}

/**
 * Streams for `seconds`, resizing the viewport periodically and sampling the
 * jump button's visibility throughout.
 *
 * Deliberately does NOT synthesise pointer movement, clicks or key presses.
 * Puppeteer's input emulation dispatches real `pointermove` events, which the
 * hook treats as a presence signal: it would reset the idle-re-engage deadline
 * and, worse, arm the gesture attribution that `userDisengagements` is meant to
 * count. Any activity here would mask exactly the failure being measured. The
 * viewport resizes are safe because `setViewport` goes through the browser, not
 * the input pipeline, and emits no pointer events.
 *
 * @param state Mutated in place, so the caller keeps observations taken before
 *              a later step throws.
 */
async function streamAndWatch(page, seconds, state, log) {
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    await sleep(Math.min(VISIBILITY_POLL_MS, deadline - Date.now()));

    state.visibilityPolls++;
    if (await isJumpButtonVisible(page)) {
      state.jumpButtonVisibleSamples++;
      if (state.firstJumpButtonSightingMs === null) {
        state.firstJumpButtonSightingMs = Date.now() - state.startedAtMs;
        log(
          `    !!! jump-to-bottom button became visible ${Math.round(
            state.firstJumpButtonSightingMs / 1000,
          )}s into the run`,
        );
      }
    }

    // The schedule lives in `state` so the ~20s cadence carries across the
    // restart rather than restarting from zero either side of it.
    if (Date.now() >= state.nextResizeAtMs) {
      state.viewportIndex = (state.viewportIndex + 1) % SOAK_VIEWPORTS.length;
      const viewport = SOAK_VIEWPORTS[state.viewportIndex];
      await page.setViewport(viewport);
      state.resizes++;
      state.nextResizeAtMs = Date.now() + RESIZE_INTERVAL_MS;
      log(`    resized to ${viewport.width}x${viewport.height}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (...m) => {
    if (!args.json) console.log(...m);
  };

  if (args.provision) {
    args.activationCode = provision(args.baseUrl, log);
  }

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

  await page.setViewport(SOAK_VIEWPORTS[0]);

  // The shipped diagnostics publish unconditionally, but the flag is set anyway
  // so this harness keeps working if publication is ever put behind it again.
  // Wrapped because localStorage throws on opaque origins such as about:blank,
  // which this also runs against.
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('scribear:debugAutoScroll', '1');
    } catch {
      /* opaque origin - nothing to do */
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
  //
  // Raise `--session-wait-seconds` to test a CALENDARED session: the whole
  // point there is that the kiosk is already running and idle when the session
  // starts, so it has to make the UPCOMING -> ACTIVE transition on its own.
  log(`--- waiting up to ${args.sessionWaitSeconds}s for the session socket`);
  for (
    let waited = 0;
    waited < args.sessionWaitSeconds && !sourceSocketOpen;
    waited += 2
  ) {
    await sleep(2000);
  }
  if (!sourceSocketOpen) {
    throw new Error(
      'Kiosk never opened a transcription-stream socket - is a session active in its room?',
    );
  }
  log('--- session socket open');

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

  // Everything from here on is the untouched phase: the page is never clicked,
  // scrolled or typed into again, so the caption view has no legitimate reason
  // to stop following the speaker.
  const soak = {
    startedAtMs: Date.now(),
    visibilityPolls: 0,
    jumpButtonVisibleSamples: 0,
    firstJumpButtonSightingMs: null,
    resizes: 0,
    viewportIndex: 0,
    nextResizeAtMs: Date.now() + RESIZE_INTERVAL_MS,
  };

  const half = Math.floor(args.streamSeconds / 2);
  log(`--- streaming ${half}s before the restart`);
  await streamAndWatch(page, half, soak, log);

  let restartAtMs = null;
  if (args.restartCmd) {
    log(`--- restarting upstream: ${args.restartCmd}`);
    restartAtMs = Date.now();
    execSync(args.restartCmd, { stdio: args.json ? 'ignore' : 'inherit' });
  }

  log(`--- streaming ${args.streamSeconds - half}s after the restart`);
  const framesBeforeTail = binaryFrames;
  await streamAndWatch(page, args.streamSeconds - half, soak, log);

  const autoScroll = await readAutoScrollDiagnostics(page);

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
  if (!autoScroll) {
    failures.push(
      'window.__scribearAutoScroll.transcription was never published - is the ' +
        'kiosk running a build with auto-scroll diagnostics?',
    );
  } else if (autoScroll.userDisengagements !== 0) {
    // Nothing touched the page after the microphone was switched on, so a
    // disengage attributed to a user gesture is a misattribution by definition.
    failures.push(
      `auto-scroll disengaged ${autoScroll.userDisengagements}x blaming a user ` +
        'gesture, but nothing touched the page',
    );
  }
  if (soak.jumpButtonVisibleSamples > 0) {
    failures.push(
      `"${JUMP_BUTTON_LABEL}" was visible in ${soak.jumpButtonVisibleSamples} of ` +
        `${soak.visibilityPolls} samples (first at ` +
        `${Math.round(soak.firstJumpButtonSightingMs / 1000)}s) - the caption ` +
        'view stopped following the speaker',
    );
  }

  const result = {
    ok: failures.length === 0,
    binaryFrames,
    transcripts: transcripts.length,
    transcriptsBeforeRestart: restartAtMs ? before : null,
    transcriptsAfterRestart: restartAtMs ? after : null,
    autoScroll: {
      userDisengagements: autoScroll?.userDisengagements ?? null,
      // Informational, never a failure: these are the events the old code would
      // have misread as a scrollback, counted as they are correctly ignored.
      suppressedDisengagements: autoScroll?.suppressedDisengagements ?? null,
      lastSuppressedDistancePx: autoScroll?.lastSuppressedDistancePx ?? null,
      idleReengagements: autoScroll?.idleReengagements ?? null,
      jumpButtonVisibleSamples: soak.jumpButtonVisibleSamples,
      visibilityPolls: soak.visibilityPolls,
      viewportResizes: soak.resizes,
    },
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
    console.log(`viewport resizes   : ${result.autoScroll.viewportResizes}`);
    console.log(
      `jump button seen   : ${result.autoScroll.jumpButtonVisibleSamples}/${result.autoScroll.visibilityPolls} samples`,
    );
    console.log(`auto-scroll counters:`);
    console.log(
      `  user disengages  : ${result.autoScroll.userDisengagements} (must be 0)`,
    );
    console.log(
      `  suppressed       : ${result.autoScroll.suppressedDisengagements} (informational - the bug, caught)`,
    );
    console.log(
      `  last suppressed  : ${result.autoScroll.lastSuppressedDistancePx}px from bottom`,
    );
    console.log(
      `  idle re-engages  : ${result.autoScroll.idleReengagements} (informational)`,
    );
    console.log(result.ok ? '\nPASS' : `\nFAIL\n - ${failures.join('\n - ')}`);
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
