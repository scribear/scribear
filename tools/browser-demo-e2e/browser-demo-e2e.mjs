/**
 * Browser demo end-to-end check: drive the *whole* operator + viewer journey
 * through real Chromium windows and assert what a human would see.
 *
 * Usage:
 *   node tools/browser-demo-e2e/browser-demo-e2e.mjs [options]
 *
 * Options:
 *   --base-url <url>       default https://localhost  (self-signed certs ok)
 *   --username <u>         admin console user   (default: from --env-file)
 *   --password <p>         admin console password
 *   --env-file <path>      .env holding ADMIN_LOCAL_CREDENTIALS
 *                          (default: deployment/.env)
 *   --screenshot-dir <d>   default ~/app-screenshots
 *   --prefix <name>        screenshot filename prefix (default browser-demo)
 *   --warmup-seconds <n>   default 45. Audio streamed before the long-lived
 *                          window starts, i.e. how long the "captions flowing"
 *                          screenshot has to become interesting.
 *   --long-lived-seconds <n>  default 400 (6m40s). MUST exceed the 300 s
 *                          session-token lifetime or the token-refresh
 *                          assertion is vacuous.
 *   --keep-room            skip the "Delete room" cleanup at the end
 *   --headful              run with a visible browser (debugging)
 *   --json                 machine-readable result on stdout
 *
 * Why this exists
 * ---------------
 * The fixes on this branch (see 2026-08-01-01-PLAN-SessionChecks.md) are
 * *rendering and timing* changes. Unit tests pin the pure derivation and a
 * raw-socket harness (tools/demo-e2e) pins the protocol, but neither can see
 * what the person in the lecture hall sees. Two of the fixes are only
 * observable in a browser over real wall-clock time:
 *
 *   - the idle room banner. A healthy room with nobody talking yet used to
 *     render as "Connection to the transcription service was lost.
 *     Reconnecting…" — a warning, styled and announced as a fault. It must now
 *     read "Waiting for the room's microphone to connect." as `role="status"`
 *     (polite), never containing the word "reconnecting".
 *   - the token-refresh timer (8ff4582). `decodeSessionTokenExpiryMs` used to
 *     read the wrong segment of the two-segment session token, so the
 *     proactive refresh timer was never armed. A viewer therefore only found
 *     out its token had died when the socket did. A 5-minute token means the
 *     bug is invisible to any check shorter than 5 minutes, which is every
 *     other check in this repo.
 *
 * So this script keeps one viewer connected for >6 minutes with audio flowing
 * and asserts it neither reconnects nor stops receiving transcripts, while a
 * screenshot of each interesting moment lands in ~/app-screenshots for a human
 * to confirm without re-running anything.
 *
 * Three separate Chromium instances, because they model three separate
 * machines and must not share cookies or localStorage: the operator's admin
 * console, the kiosk on the wall (fake audio capture device), and the
 * audience member's phone.
 *
 * Requires a running stack. Chrome is auto-detected from CHROME_PATH, then the
 * usual system locations — same as tools/e2e-audio.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/** Speech fixture played into Chrome's fake microphone. Loops when exhausted. */
const WAV = join(
  REPO_ROOT,
  'test_audio_files',
  'speech',
  'harvard_16k_mono.wav',
);

/** The exact string the idle-room fix must render. */
const IDLE_BANNER = "Waiting for the room's microphone to connect.";

/** Session tokens live 5 minutes; the client refreshes at 50% of remaining. */
const SESSION_TOKEN_TTL_SECONDS = 300;

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    `No Chrome/Chromium found. Set CHROME_PATH. Tried: ${CHROME_CANDIDATES.join(', ')}`,
  );
}

function parseArgs(argv) {
  const a = {
    baseUrl: 'https://localhost',
    username: '',
    password: '',
    envFile: join(REPO_ROOT, 'deployment', '.env'),
    screenshotDir: join(homedir(), 'app-screenshots'),
    prefix: 'browser-demo',
    warmupSeconds: 45,
    longLivedSeconds: 400,
    keepRoom: false,
    headful: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--json') a.json = true;
    else if (f === '--keep-room') a.keepRoom = true;
    else if (f === '--headful') a.headful = true;
    else if (f === '--base-url') a.baseUrl = argv[++i];
    else if (f === '--username') a.username = argv[++i];
    else if (f === '--password') a.password = argv[++i];
    else if (f === '--env-file') a.envFile = argv[++i];
    else if (f === '--screenshot-dir') a.screenshotDir = argv[++i];
    else if (f === '--prefix') a.prefix = argv[++i];
    else if (f === '--warmup-seconds') a.warmupSeconds = Number(argv[++i]);
    else if (f === '--long-lived-seconds')
      a.longLivedSeconds = Number(argv[++i]);
    else throw new Error(`Unknown option: ${f}`);
  }
  return a;
}

/**
 * Admin credentials from `ADMIN_LOCAL_CREDENTIALS` ("<user> <password>"), so
 * the common case needs no flags. Deliberately a plain scan rather than a
 * dotenv dependency — mirrors tools/e2e-audio's reasoning: one key is needed
 * and the file's values are unquoted shell-hostile strings.
 */
function credsFromEnv(args) {
  if (args.username && args.password) return args;
  try {
    const env = readFileSync(args.envFile, 'utf8');
    const line = env
      .split('\n')
      .find((l) => l.startsWith('ADMIN_LOCAL_CREDENTIALS='));
    if (line) {
      const val = line.slice('ADMIN_LOCAL_CREDENTIALS='.length).trim();
      const [user, ...rest] = val.split(/\s+/);
      if (user && rest.length) {
        return {
          ...args,
          username: args.username || user,
          password: args.password || rest.join(' '),
        };
      }
    }
  } catch {
    // optional; --username/--password still work
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A single assertion result. `id` names the fix or behaviour it pins. */
function check(id, name, ok, detail = '') {
  return { id, name, ok, detail };
}

/** Click the first visible control whose text or aria-label contains `needle`. */
function clickByText(page, needle, scope = '') {
  return page.evaluate(
    (text, sel) => {
      const root = sel ? document.querySelector(sel) : document;
      if (!root) return false;
      const els = [
        ...root.querySelectorAll(
          'button, [role="button"], a, li[role="option"]',
        ),
      ];
      const hit = els.find(
        (el) =>
          (el.textContent ?? '').trim().toLowerCase().includes(text) ||
          (el.getAttribute('aria-label') ?? '').toLowerCase().includes(text),
      );
      if (!hit) return false;
      hit.click();
      return true;
    },
    needle.toLowerCase(),
    scope,
  );
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

/**
 * Read the connection banner as assistive technology would: its ARIA role and
 * its text. The banner is the only `position: fixed` live region either webapp
 * renders, which is what distinguishes it from toasts and inline field errors.
 *
 * Returns `null` when no banner is shown — which is itself an assertion
 * (captions flowing means no banner at all, not a quieter one).
 */
function readBanner(page) {
  return page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll('[role="status"],[role="alert"]'),
    ];
    for (const n of nodes) {
      const style = window.getComputedStyle(n);
      const text = (n.innerText ?? '').trim();
      if (style.position === 'fixed' && text.length > 0) {
        return { role: n.getAttribute('role'), text };
      }
    }
    return null;
  });
}

/** Text inside the client's live-caption region (`role="log"`). */
function readTranscript(page) {
  return page.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    return log ? (log.innerText ?? '').trim() : '';
  });
}

async function shot(page, dir, prefix, name, log) {
  const path = join(dir, `${prefix}-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  log(`    screenshot -> ${path}`);
  return path;
}

/**
 * Instrument a page's network so the long-lived assertions have evidence
 * rather than a vibe: how many viewer sockets were ever opened, when
 * transcripts arrived, and whether the token-refresh call actually fired.
 */
async function instrumentClient(page) {
  const state = {
    socketsCreated: 0,
    socketsClosed: 0,
    // Sockets the app opens before it knows its own session uid, i.e.
    // `.../transcription-stream/undefined/client`. Counted separately so they
    // can't be mistaken for a reconnect: see the README's Notes.
    undefinedSessionSockets: 0,
    transcriptAtMs: [],
    tokenRefreshes: 0,
    consoleErrors: [],
  };
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  // Navigations keep the target (and therefore this session) alive, but the
  // client-webapp reloads itself once after consuming the #config fragment,
  // so re-enable defensively rather than trust that.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      cdp.send('Network.enable').catch(() => {});
    }
  });
  cdp.on('Network.webSocketCreated', (e) => {
    if (!e.url.includes('/transcription-stream/')) return;
    if (e.url.includes('/transcription-stream/undefined/')) {
      state.undefinedSessionSockets++;
      return;
    }
    state.socketsCreated++;
  });
  cdp.on('Network.webSocketClosed', () => {
    state.socketsClosed++;
  });
  cdp.on('Network.webSocketFrameReceived', (e) => {
    if (e.response.opcode !== 1) return;
    if (e.response.payloadData.includes('"type":"transcript"')) {
      state.transcriptAtMs.push(Date.now());
    }
  });
  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.request.url.includes('refresh-session-token')) state.tokenRefreshes++;
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') state.consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    state.consoleErrors.push(String(err));
  });
  return state;
}

async function main() {
  const args = credsFromEnv(parseArgs(process.argv.slice(2)));
  const log = (...m) => {
    if (!args.json) console.log(...m);
  };
  if (!args.username || !args.password) {
    throw new Error(
      `No admin credentials. Pass --username/--password or point --env-file at a file with ADMIN_LOCAL_CREDENTIALS (tried ${args.envFile}).`,
    );
  }
  if (args.longLivedSeconds <= SESSION_TOKEN_TTL_SECONDS) {
    log(
      `!!! --long-lived-seconds ${args.longLivedSeconds} does not exceed the ` +
        `${SESSION_TOKEN_TTL_SECONDS}s token lifetime; the refresh assertion will be vacuous.`,
    );
  }
  mkdirSync(args.screenshotDir, { recursive: true });

  const chrome = resolveChrome();
  const results = [];
  const screenshots = [];
  const artifacts = {};
  let admin, kiosk, client;
  let adminPage, kioskPage, clientPage;
  let clientNet = null;
  let roomUid = null;

  const launch = (extraArgs = []) =>
    puppeteer.launch({
      executablePath: chrome,
      headless: !args.headful,
      acceptInsecureCerts: true,
      defaultViewport: { width: 1280, height: 800 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        ...extraArgs,
      ],
    });

  try {
    // =====================================================================
    // Operator's browser: the real admin console, real login form.
    // =====================================================================
    admin = await launch();
    adminPage = await admin.newPage();
    adminPage.setDefaultTimeout(20_000);

    log('--- [admin] logging in through the login form');
    await adminPage.goto(`${args.baseUrl}/admin/`, {
      waitUntil: 'networkidle2',
    });
    await adminPage.waitForSelector('input[autocomplete="username"]', {
      visible: true,
    });
    await adminPage.type('input[autocomplete="username"]', args.username);
    await adminPage.type('input[type="password"]', args.password);
    await adminPage.click('button[type="submit"]');
    const authed = await until(
      () =>
        adminPage.evaluate(
          () => !document.querySelector('input[autocomplete="username"]'),
        ),
      20_000,
    );
    results.push(
      check(
        'ADMIN_LOGIN_VIA_UI',
        'admin console login through the real form',
        !!authed,
        authed
          ? 'Authenticated; login form gone.'
          : 'Login form never cleared.',
      ),
    );
    if (!authed) throw new Error('admin login failed');

    const stamp = `bdemo-${process.pid}-${Math.floor(Date.now() / 1000)}`;
    artifacts.stamp = stamp;

    // ---- Register a device through the Devices page --------------------
    log('--- [admin] Devices -> Register device');
    await adminPage.goto(`${args.baseUrl}/admin/devices`, {
      waitUntil: 'networkidle2',
    });
    if (!(await clickByText(adminPage, 'register device'))) {
      throw new Error('no "Register device" button on /admin/devices');
    }
    await adminPage.waitForSelector('.MuiDialog-root input', { visible: true });
    await adminPage.type('.MuiDialog-root input', `${stamp}-kiosk`);
    await clickByText(adminPage, 'register device', '.MuiDialog-root');
    // The dialog stays open showing the code so an operator can type it.
    const activationCode = await until(
      () =>
        adminPage.evaluate(() => {
          const dlg = document.querySelector('.MuiDialog-root');
          if (!dlg) return null;
          const m = /\b[A-Z0-9]{8}\b/.exec(dlg.innerText ?? '');
          return m ? m[0] : null;
        }),
      20_000,
    );
    results.push(
      check(
        'DEVICE_REGISTERED_VIA_UI',
        'device registered and activation code shown in the dialog',
        activationCode !== null,
        activationCode
          ? `Activation code ${activationCode} read off the dialog (expires in 5 min).`
          : 'The register dialog never showed an activation code.',
      ),
    );
    if (!activationCode) throw new Error('no activation code');
    artifacts.activationCode = activationCode;
    await clickByText(adminPage, 'done', '.MuiDialog-root');
    await sleep(500);

    // ---- Create a room with that device as source ----------------------
    log('--- [admin] Rooms -> New room');
    await adminPage.goto(`${args.baseUrl}/admin/rooms`, {
      waitUntil: 'networkidle2',
    });
    if (!(await clickByText(adminPage, 'new room'))) {
      throw new Error('no "New room" button on /admin/rooms');
    }
    await adminPage.waitForSelector('.MuiDialog-root input', { visible: true });
    await adminPage.type('.MuiDialog-root input', `${stamp}-room`);
    // Source device is a MUI Select; open it and pick our freshly-made device
    // by name (the list is loaded async, so wait for the option).
    await adminPage.click(
      '.MuiDialog-root [role="combobox"], .MuiDialog-root .MuiSelect-select',
    );
    const picked = await until(
      () =>
        clickByText(
          adminPage,
          `${stamp}-kiosk`,
          '.MuiPopover-root, .MuiMenu-root',
        ),
      15_000,
    );
    if (!picked) throw new Error('device never appeared in the source picker');
    await sleep(300);
    await clickByText(adminPage, 'create', '.MuiDialog-root');
    // Filter the list to our room and open it.
    await adminPage.waitForSelector('input[type="text"]', { visible: true });
    await adminPage.type('input[type="text"]', `${stamp}-room`);
    const roomRow = await until(
      () =>
        adminPage.evaluate((needle) => {
          const row = [...document.querySelectorAll('tbody tr')].find((r) =>
            (r.innerText ?? '').includes(needle),
          );
          if (!row) return false;
          row.click();
          return true;
        }, `${stamp}-room`),
      20_000,
    );
    if (roomRow) {
      await until(
        () =>
          adminPage.evaluate(() =>
            /^\/admin\/rooms\/[0-9a-f-]{8,}/.test(window.location.pathname),
          ),
        15_000,
      );
      roomUid = await adminPage.evaluate(
        () => window.location.pathname.split('/')[3] ?? null,
      );
    }
    results.push(
      check(
        'ROOM_CREATED_VIA_UI',
        'room created from the New room dialog with the device as source',
        roomUid !== null,
        roomUid
          ? `Room ${roomUid} created and opened from the rooms table.`
          : 'The new room never appeared in the rooms table.',
      ),
    );
    if (!roomUid) throw new Error('room creation failed');
    artifacts.roomUid = roomUid;

    // =====================================================================
    // Kiosk browser: activate the device through the real kiosk webapp.
    // Fake audio capture device, microphone pre-granted.
    // =====================================================================
    log('--- [kiosk] activating the device in the real kiosk webapp');
    kiosk = await launch([
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ]);
    // Pre-grant the microphone. Without this the kiosk stops at INFO_PROMPT
    // waiting for a second activation call, which reads as "connected but
    // silent" — the same symptom as a genuine audio fault.
    await kiosk
      .defaultBrowserContext()
      .overridePermissions(args.baseUrl, ['microphone']);
    kioskPage = await kiosk.newPage();
    kioskPage.setDefaultTimeout(20_000);
    const kioskNet = {
      sourceSocketOpen: false,
      binaryFrames: 0,
    };
    const kioskCdp = await kioskPage.createCDPSession();
    await kioskCdp.send('Network.enable');
    kioskPage.on('framenavigated', (frame) => {
      if (frame === kioskPage.mainFrame()) {
        kioskCdp.send('Network.enable').catch(() => {});
      }
    });
    kioskCdp.on('Network.webSocketCreated', (e) => {
      if (e.url.includes('/transcription-stream/'))
        kioskNet.sourceSocketOpen = true;
    });
    kioskCdp.on('Network.webSocketFrameSent', (e) => {
      if (e.response.opcode === 2) kioskNet.binaryFrames++;
    });

    await kioskPage.goto(`${args.baseUrl}/kiosk/`, {
      waitUntil: 'networkidle2',
      timeout: 60_000,
    });
    const needsActivation = await until(
      () =>
        kioskPage.evaluate(() =>
          document.body.innerText.includes('not registered'),
        ),
      20_000,
    );
    if (!needsActivation) {
      throw new Error('kiosk did not offer the activation form');
    }
    await kioskPage.type('input', activationCode);
    await clickByText(kioskPage, 'activate');
    const activated = await until(
      () =>
        kioskPage.evaluate(
          () => !document.body.innerText.includes('not registered'),
        ),
      30_000,
    );
    results.push(
      check(
        'KIOSK_ACTIVATED_VIA_UI',
        'device activated by typing the code into the kiosk webapp',
        !!activated,
        activated
          ? 'Kiosk left the activation form; device is bound to this browser.'
          : 'Kiosk still shows the activation form.',
      ),
    );
    if (!activated) throw new Error('kiosk activation failed');

    // Park the kiosk. The whole point of the headline assertion is that the
    // viewer is watching a room whose microphone has NOT connected yet, and
    // the kiosk opens its source socket the moment a session goes active — so
    // it must be off the page while the session starts. Cookies survive.
    log('--- [kiosk] parking the kiosk so the room stays source-free');
    await kioskPage.goto('about:blank');

    // =====================================================================
    // Start the session, then get the viewer URL off the session page.
    // =====================================================================
    log('--- [admin] Manage scheduling -> Start a session now');
    await adminPage.goto(`${args.baseUrl}/admin/rooms/${roomUid}/scheduling`, {
      waitUntil: 'networkidle2',
    });
    if (!(await clickByText(adminPage, 'start a session now'))) {
      throw new Error('no "Start a session now" button on the scheduling page');
    }
    await adminPage.waitForSelector('.MuiDialog-root input', { visible: true });
    await adminPage.type('.MuiDialog-root input', `${stamp}-session`);
    await clickByText(adminPage, 'start session', '.MuiDialog-root');
    // The dialog navigates to /admin/sessions/:uid on success.
    const sessionUid = await until(
      () =>
        adminPage.evaluate(() => {
          const m = /^\/admin\/sessions\/([0-9a-f-]{8,})/.exec(
            window.location.pathname,
          );
          return m ? m[1] : null;
        }),
      30_000,
    );
    results.push(
      check(
        'SESSION_STARTED_VIA_UI',
        'on-demand session started from the scheduling page',
        sessionUid !== null,
        sessionUid
          ? `Session ${sessionUid}; the dialog navigated straight to its detail page.`
          : 'Never landed on a session detail page.',
      ),
    );
    if (!sessionUid) throw new Error('session creation failed');
    artifacts.sessionUid = sessionUid;

    // Join codes are minted lazily — this page (and the fleet panel) are the
    // only things that mint one, which is exactly the step the demo runbook
    // was missing.
    log(
      '--- [admin] reading the "Open live captions" link (mints a join code)',
    );
    const joinUrl = await until(
      () =>
        adminPage.evaluate(() => {
          const a = [...document.querySelectorAll('a')].find((el) =>
            /open live captions/i.test(el.textContent ?? ''),
          );
          return a ? a.getAttribute('href') : null;
        }),
      60_000,
    );
    results.push(
      check(
        'JOIN_URL_FROM_SESSION_PAGE',
        '"Open live captions" offers a viewer URL (lazy join-code mint)',
        joinUrl !== null,
        joinUrl
          ? `Viewer URL: ${joinUrl}`
          : 'The session page never rendered a join link within 60s.',
      ),
    );
    if (!joinUrl) throw new Error('no join URL');
    artifacts.joinUrl = joinUrl;
    screenshots.push(
      await shot(
        adminPage,
        args.screenshotDir,
        args.prefix,
        '00-admin-session-detail',
        log,
      ),
    );

    // =====================================================================
    // Viewer browser: join BEFORE the kiosk is anywhere near the room.
    // =====================================================================
    log('--- [client] opening the viewer URL');
    client = await launch();
    clientPage = await client.newPage();
    clientPage.setDefaultTimeout(20_000);
    // Instrument from about:blank and go straight to the join URL. Loading
    // `/client/` first and *then* navigating to `/client/#config=…` looks
    // equivalent but is not: a fragment-only change is a same-document
    // navigation, the app never re-initializes, and the config middleware
    // (which runs once, on redux-remember rehydration) never sees the code.
    clientNet = await instrumentClient(clientPage);
    await clientPage.goto(joinUrl, {
      waitUntil: 'networkidle2',
      timeout: 60_000,
    });

    // The app consumes the fragment, reloads once, then auto-joins; the Join
    // Session dialog closes when the lifecycle reaches ACTIVE.
    const joined = await until(
      () =>
        clientPage.evaluate(
          () => !document.body.innerText.includes('Join Session'),
        ),
      60_000,
    );
    const joinDialogError = joined
      ? null
      : await clientPage.evaluate(() => {
          const a = document.querySelector('.MuiDialog-root [role="alert"]');
          return a ? (a.innerText ?? '').trim() : null;
        });
    results.push(
      check(
        'VIEWER_JOINED_VIA_URL',
        'viewer joined from the admin-provided link with no typing',
        !!joined,
        joined
          ? 'Join Session dialog closed; the client is ACTIVE.'
          : `Join Session dialog never closed. Dialog error: ${joinDialogError ?? '(none rendered)'}`,
      ),
    );
    if (!joined) throw new Error('viewer never joined');

    // -------------------------------------------------------------------
    // THE HEADLINE ASSERTION.
    // A healthy room with nobody talking yet. Before this branch this state
    // rendered "Connection to the transcription service was lost.
    // Reconnecting…" as a role="alert" warning, and stayed up forever.
    // -------------------------------------------------------------------
    log('--- [client] reading the idle banner (source-free room)');
    const idleBanner = await until(
      () => readBanner(clientPage).then((b) => (b?.text ? b : null)),
      30_000,
    );
    screenshots.push(
      await shot(
        clientPage,
        args.screenshotDir,
        args.prefix,
        '01-idle-waiting-for-microphone',
        log,
      ),
    );
    const bannerText = idleBanner?.text ?? '(no banner)';
    const bannerRole = idleBanner?.role ?? '(none)';
    results.push(
      check(
        'IDLE_BANNER_IS_INFORMATIONAL',
        'idle room reads "Waiting for the room\'s microphone to connect."',
        idleBanner !== null && bannerText === IDLE_BANNER,
        `role="${bannerRole}" text=${JSON.stringify(bannerText)}`,
      ),
    );
    results.push(
      check(
        'IDLE_BANNER_NOT_A_FAULT',
        'idle banner never says "reconnecting" and is polite, not assertive',
        !/reconnect/i.test(bannerText) && bannerRole === 'status',
        `role="${bannerRole}" (want "status"); "reconnect" present: ${/reconnect/i.test(bannerText)}`,
      ),
    );

    // =====================================================================
    // Bring the kiosk back and stream.
    // =====================================================================
    log('--- [kiosk] reopening the kiosk; it should find the live session');
    await kioskPage.goto(`${args.baseUrl}/kiosk/`, {
      waitUntil: 'networkidle2',
      timeout: 60_000,
    });
    const sourceUp = await until(
      () => kioskNet.sourceSocketOpen,
      120_000,
      1000,
    );
    if (!sourceUp) {
      throw new Error(
        'kiosk never opened a transcription-stream socket for the live session',
      );
    }
    log('--- [kiosk] source socket open; enabling the microphone');
    // The mic control is a toggle, so a fixed number of clicks is a coin flip.
    // Click, then confirm audio is actually on the wire.
    let streaming = false;
    for (let attempt = 1; attempt <= 4 && !streaming; attempt++) {
      const before = kioskNet.binaryFrames;
      await clickByText(kioskPage, 'microphone');
      await sleep(4000);
      streaming = kioskNet.binaryFrames > before + 5;
      log(
        `    attempt ${attempt}: frames ${before} -> ${kioskNet.binaryFrames}`,
      );
    }
    if (!streaming) {
      throw new Error('microphone never started streaming from the kiosk');
    }

    log(`--- [client] streaming ${args.warmupSeconds}s; banner should clear`);
    const bannerCleared = await until(
      () => readBanner(clientPage).then((b) => b === null),
      60_000,
      1000,
    );
    results.push(
      check(
        'BANNER_CLEARS_WHEN_AUDIO_FLOWS',
        'the waiting banner disappears once the room has a microphone',
        !!bannerCleared,
        bannerCleared
          ? 'No banner rendered at all once the source connected.'
          : `Banner still up: ${JSON.stringify(await readBanner(clientPage))}`,
      ),
    );

    const transcriptText = await until(
      () => readTranscript(clientPage).then((t) => (t.length > 0 ? t : null)),
      args.warmupSeconds * 1000 + 60_000,
      1000,
    );
    results.push(
      check(
        'TRANSCRIPT_RENDERED_IN_BROWSER',
        "transcript text appears in the viewer's live-caption region",
        transcriptText !== null,
        transcriptText
          ? `role="log" contains ${transcriptText.length} chars, e.g. ${JSON.stringify(transcriptText.slice(0, 80))}`
          : 'The live-caption region stayed empty.',
      ),
    );
    await sleep(Math.max(0, args.warmupSeconds * 1000 - 15_000));
    screenshots.push(
      await shot(
        clientPage,
        args.screenshotDir,
        args.prefix,
        '02-captions-flowing',
        log,
      ),
    );
    screenshots.push(
      await shot(
        kioskPage,
        args.screenshotDir,
        args.prefix,
        '02b-kiosk-streaming',
        log,
      ),
    );

    // =====================================================================
    // THE LONG-LIVED VIEWER. This is the assertion that only wall-clock time
    // can make: the session token lives 5 minutes and, before 8ff4582, the
    // refresh timer was never armed because the expiry was decoded from the
    // wrong token segment.
    // =====================================================================
    const socketsAtStart = clientNet.socketsCreated;
    const refreshesAtStart = clientNet.tokenRefreshes;
    const windowStart = Date.now();
    log(
      `--- [client] holding the viewer for ${args.longLivedSeconds}s ` +
        `(token TTL ${SESSION_TOKEN_TTL_SECONDS}s) with audio flowing`,
    );
    for (let elapsed = 0; elapsed < args.longLivedSeconds; ) {
      const step = Math.min(30, args.longLivedSeconds - elapsed);
      await sleep(step * 1000);
      elapsed += step;
      const banner = await readBanner(clientPage);
      log(
        `    t+${elapsed}s sockets=${clientNet.socketsCreated} ` +
          `refreshes=${clientNet.tokenRefreshes} ` +
          `transcripts=${clientNet.transcriptAtMs.length} ` +
          `banner=${banner ? JSON.stringify(banner.text) : 'none'}`,
      );
    }
    const windowEnd = Date.now();
    screenshots.push(
      await shot(
        clientPage,
        args.screenshotDir,
        args.prefix,
        '03-long-lived-viewer',
        log,
      ),
    );

    const extraSockets = clientNet.socketsCreated - socketsAtStart;
    const refreshes = clientNet.tokenRefreshes - refreshesAtStart;
    const recentTranscripts = clientNet.transcriptAtMs.filter(
      (t) => t > windowEnd - 90_000,
    ).length;
    const finalBanner = await readBanner(clientPage);

    results.push(
      check(
        'LONG_LIVED_VIEWER_NEVER_RECONNECTS',
        `viewer survives ${Math.round((windowEnd - windowStart) / 1000)}s on one socket ` +
          `(token TTL ${SESSION_TOKEN_TTL_SECONDS}s)`,
        extraSockets === 0,
        `${extraSockets} additional transcription-stream socket(s) opened during the window ` +
          `(want 0; a reconnect loop is what the dead refresh timer used to cause).`,
      ),
    );
    results.push(
      check(
        'TOKEN_REFRESH_TIMER_ARMED',
        'the proactive session-token refresh actually fires (8ff4582)',
        refreshes >= 1,
        `${refreshes} refresh-session-token call(s) in the window. Before the fix the ` +
          `timer was never armed and this would be 0.`,
      ),
    );
    results.push(
      check(
        'TRANSCRIPTS_STILL_FLOWING_AFTER_TOKEN_TTL',
        'transcripts keep arriving past the token lifetime',
        recentTranscripts > 0 && finalBanner === null,
        `${recentTranscripts} transcript frames in the last 90s; ` +
          `banner=${finalBanner ? JSON.stringify(finalBanner.text) : 'none'}`,
      ),
    );

    // =====================================================================
    // End the session from the admin UI; the viewer should say so and go back
    // to the join prompt rather than hang or reconnect-loop.
    // =====================================================================
    log('--- [admin] End early on the session detail page');
    await adminPage.goto(`${args.baseUrl}/admin/sessions/${sessionUid}`, {
      waitUntil: 'networkidle2',
    });
    const endClicked = await until(
      () => clickByText(adminPage, 'end early'),
      20_000,
    );
    if (!endClicked)
      throw new Error('no "End early" button on the session page');
    await adminPage.waitForSelector('.MuiDialog-root', { visible: true });
    await clickByText(adminPage, 'end early', '.MuiDialog-root');

    const backToJoin = await until(
      () =>
        clientPage.evaluate(() =>
          document.body.innerText.includes('Join Session'),
        ),
      60_000,
      1000,
    );
    screenshots.push(
      await shot(
        clientPage,
        args.screenshotDir,
        args.prefix,
        '04-session-ended-join-prompt',
        log,
      ),
    );
    // What, if anything, the viewer is told about *why* the session ended.
    // Recorded rather than asserted: the branch's fix is "don't hang", and
    // node-server's end-watch (bc37f92) is what makes the prompt come back at
    // all. Whether the client explains it is a separate, still-open finding —
    // see the README.
    const endExplanation = await clientPage.evaluate(() => {
      const dlg = document.querySelector('.MuiDialog-root');
      const alertEl = dlg?.querySelector('[role="alert"]');
      const banner = [
        ...document.querySelectorAll('[role="status"],[role="alert"]'),
      ]
        .filter((n) => window.getComputedStyle(n).position === 'fixed')
        .map((n) => (n.innerText ?? '').trim())
        .filter((t) => t.length > 0);
      return {
        dialogAlert: alertEl ? (alertEl.innerText ?? '').trim() : null,
        fieldInErrorState: !!dlg?.querySelector('.Mui-error'),
        banners: banner,
      };
    });
    results.push(
      check(
        'SESSION_END_RETURNS_VIEWER_TO_JOIN_PROMPT',
        'ending the session drops the viewer back to the join prompt',
        !!backToJoin,
        backToJoin
          ? 'Join Session dialog reopened after the server closed the socket (1000). ' +
              `Explanation shown to the viewer: ${JSON.stringify(endExplanation)}`
          : 'The viewer never returned to the join prompt — it hung on the ended session.',
      ),
    );
  } catch (err) {
    results.push({
      id: 'HARNESS_ERROR',
      name: 'harness',
      ok: false,
      detail: err?.stack || String(err),
    });
    // A failure screenshot is worth more than the stack alone.
    for (const [name, page] of [
      ['zz-failure-client', clientPage],
      ['zz-failure-admin', adminPage],
      ['zz-failure-kiosk', kioskPage],
    ]) {
      if (!page) continue;
      try {
        screenshots.push(
          await shot(page, args.screenshotDir, args.prefix, name, log),
        );
      } catch {
        // page may already be gone
      }
    }
  } finally {
    if (adminPage && roomUid && !args.keepRoom) {
      try {
        await adminPage.goto(`${args.baseUrl}/admin/rooms/${roomUid}`, {
          waitUntil: 'networkidle2',
        });
        await clickByText(adminPage, 'delete room');
        await sleep(500);
        await clickByText(adminPage, 'delete', '.MuiDialog-root');
        await sleep(1500);
        log(`--- [admin] deleted room ${roomUid}`);
      } catch (e) {
        log(`--- cleanup failed: ${e.message}`);
      }
    } else if (roomUid) {
      log(`--- kept room ${roomUid} (--keep-room)`);
    }
    for (const b of [client, kiosk, admin]) {
      if (b) await b.close().catch(() => {});
    }
  }

  const failures = results.filter((r) => !r.ok);
  const summary = {
    ok: failures.length === 0,
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    artifacts,
    screenshots,
    clientNetwork: clientNet
      ? {
          socketsCreated: clientNet.socketsCreated,
          socketsClosed: clientNet.socketsClosed,
          undefinedSessionSockets: clientNet.undefinedSessionSockets,
          transcriptFrames: clientNet.transcriptAtMs.length,
          tokenRefreshes: clientNet.tokenRefreshes,
          consoleErrors: clientNet.consoleErrors.slice(0, 20),
        }
      : null,
    results,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('\n=== RESULT ===');
    for (const r of results) {
      console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.id}: ${r.name}`);
      if (r.detail) console.log(`        ${r.detail}`);
    }
    console.log('\nScreenshots:');
    for (const s of screenshots) console.log(`  ${s}`);
    console.log(`\n${summary.passed}/${summary.total} checks passed.`);
  }
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(2);
});
