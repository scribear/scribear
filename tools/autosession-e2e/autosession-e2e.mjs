/**
 * AUTO-session admin-UI -> kiosk pickup end-to-end check.
 *
 * Grew out of an investigation into whether an AUTO-session window created
 * through the real admin UI actually reaches a live kiosk and viewer (it
 * does - see README.md). Structure and helpers borrowed from
 * tools/browser-demo-e2e/browser-demo-e2e.mjs.
 *
 * It drives the REAL admin console and the REAL kiosk webapp, and at every hop
 * it reads *server* state (admin BFF, via fetch inside the logged-in admin
 * page) rather than trusting rendered text, so a failure names the hop.
 *
 * Phases:
 *   0  login, register device, create room (New room dialog), activate kiosk,
 *      leave the kiosk PARKED and idle on /kiosk/ (this is the scenario the
 *      earlier inconclusive run used: a kiosk already waiting when the window
 *      is created).
 *   A  create an AUTO window through the "New window" dialog exactly as an
 *      operator would, leaving every other room setting at the UI's default.
 *      Then watch (a) windows-list, (b) sessions-list, (c) the kiosk's
 *      my-schedule long-poll, (d) the kiosk's lifecycle + source socket.
 *   B  flip the room's "Auto-sessions" switch ON in the UI, and watch the
 *      same four signals again.
 *   C  (only if a session materialized) enable the kiosk mic, mint a join URL
 *      from the session detail page, open a viewer, assert captions.
 *   D  a *future* window with the switch already on: the demo scenario proper
 *      (parked kiosk, schedule a window starting ~75s out, watch it go live).
 *
 * See README.md for a full walkthrough, options, and what each phase proves.
 *
 * Usage:
 *   node tools/autosession-e2e/autosession-e2e.mjs \
 *        --base-url https://localhost:8443 \
 *        --env-file ~/scribear2/deployment-iso/.env
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
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
].filter(Boolean);

const WAV = join(
  REPO_ROOT,
  'test_audio_files',
  'speech',
  'harvard_16k_mono.wav',
);

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('No Chrome/Chromium found. Set CHROME_PATH.');
}

function parseArgs(argv) {
  const a = {
    baseUrl: 'https://localhost:8443',
    username: '',
    password: '',
    // Defaults to the isolated stack, not the primary deployment - this
    // harness creates/deletes a room and a device, so it shouldn't run
    // against a stack someone is using. See ~/scribear2/deployment-iso/README.md.
    envFile: join(homedir(), 'scribear2', 'deployment-iso', '.env'),
    screenshotDir: join(homedir(), 'app-screenshots'),
    prefix: 'autosession',
    phaseAWaitSeconds: 200,
    phaseBWaitSeconds: 200,
    keepRoom: false,
    headful: false,
    skipCaptions: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--keep-room') a.keepRoom = true;
    else if (f === '--headful') a.headful = true;
    else if (f === '--skip-captions') a.skipCaptions = true;
    else if (f === '--base-url') a.baseUrl = argv[++i];
    else if (f === '--username') a.username = argv[++i];
    else if (f === '--password') a.password = argv[++i];
    else if (f === '--env-file') a.envFile = argv[++i];
    else if (f === '--screenshot-dir') a.screenshotDir = argv[++i];
    else if (f === '--prefix') a.prefix = argv[++i];
    else if (f === '--phase-a-seconds') a.phaseAWaitSeconds = Number(argv[++i]);
    else if (f === '--phase-b-seconds') a.phaseBWaitSeconds = Number(argv[++i]);
    else throw new Error(`Unknown option: ${f}`);
  }
  return a;
}

function credsFromEnv(args) {
  if (args.username && args.password) return args;
  const env = readFileSync(args.envFile, 'utf8');
  const line = env
    .split('\n')
    .find((l) => l.startsWith('ADMIN_LOCAL_CREDENTIALS='));
  if (!line) throw new Error('no ADMIN_LOCAL_CREDENTIALS in env file');
  const val = line.slice('ADMIN_LOCAL_CREDENTIALS='.length).trim();
  const [user, ...rest] = val.split(/\s+/);
  return { ...args, username: user, password: rest.join(' ') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...m) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
};

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

async function until(fn, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

async function shot(page, dir, prefix, name) {
  const path = join(dir, `${prefix}-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  log(`    screenshot -> ${path}`);
  return path;
}

/**
 * Set a React-controlled input's value the way a user would, so the component's
 * onChange actually fires. Needed for type="time" / type="datetime-local",
 * which cannot reliably be typed into.
 */
function setInput(page, selector, value, index = 0) {
  return page.evaluate(
    (sel, val, idx) => {
      const el = document.querySelectorAll(sel)[idx];
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    selector,
    value,
    index,
  );
}

/** GET the admin BFF from inside the authenticated admin page. */
function adminGet(page, path) {
  return page.evaluate(async (p) => {
    const res = await fetch(`/api/admin/v1${p}`, { credentials: 'include' });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }, path);
}

async function serverSnapshot(adminPage, roomUid) {
  const from = new Date(Date.now() - 24 * 3600_000).toISOString();
  const to = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
  const [room, windows, sessions] = await Promise.all([
    adminGet(adminPage, `/rooms/get/${roomUid}`),
    adminGet(adminPage, `/auto-windows/list?roomUid=${roomUid}`),
    adminGet(
      adminPage,
      `/sessions/list?roomUids=${roomUid}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  ]);
  return {
    autoSessionEnabled: room.body?.data?.autoSessionEnabled ?? null,
    roomTimezone: room.body?.data?.timezone ?? null,
    roomScheduleVersion: room.body?.data?.roomScheduleVersion ?? null,
    windows: (windows.body?.data?.items ?? []).map((w) => ({
      uid: w.uid,
      days: w.daysOfWeek,
      local: `${w.localStartTime}-${w.localEndTime}`,
      activeStart: w.activeStart,
      activeEnd: w.activeEnd,
    })),
    sessions: (sessions.body?.data?.items ?? []).map((s) => ({
      uid: s.uid,
      type: s.type,
      name: s.name,
      effectiveStart: s.effectiveStart,
      effectiveEnd: s.effectiveEnd,
    })),
    raw: { room: room.status, windows: windows.status, sessions: sessions.status },
  };
}

function sessionCoveringNow(snap) {
  const now = Date.now();
  return (
    snap.sessions.find(
      (s) =>
        Date.parse(s.effectiveStart) <= now &&
        (s.effectiveEnd === null || Date.parse(s.effectiveEnd) > now),
    ) ?? null
  );
}

async function kioskState(kioskPage) {
  return kioskPage.evaluate(() => ({
    text: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 220),
  }));
}

async function main() {
  const args = credsFromEnv(parseArgs(process.argv.slice(2)));
  mkdirSync(args.screenshotDir, { recursive: true });
  const chrome = resolveChrome();
  const timeline = [];
  const screenshots = [];
  const findings = {};
  let admin, kiosk, client;
  let adminPage, kioskPage, clientPage;
  let roomUid = null;

  const record = (event, data) => {
    timeline.push({ t: new Date().toISOString(), event, ...data });
    log(`### ${event}`, JSON.stringify(data));
  };

  const launch = (extraArgs = []) =>
    puppeteer.launch({
      executablePath: chrome,
      headless: !args.headful,
      acceptInsecureCerts: true,
      defaultViewport: { width: 1280, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        ...extraArgs,
      ],
    });

  try {
    // ================= Phase 0: provisioning through the real UI ===========
    admin = await launch();
    adminPage = await admin.newPage();
    adminPage.setDefaultTimeout(20_000);

    log('--- [admin] login');
    await adminPage.goto(`${args.baseUrl}/admin/`, { waitUntil: 'networkidle2' });
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
    if (!authed) throw new Error('admin login failed');

    const stamp = `auto-${process.pid}-${Math.floor(Date.now() / 1000)}`;
    log(`--- stamp ${stamp}`);

    log('--- [admin] Devices -> Register device');
    await adminPage.goto(`${args.baseUrl}/admin/devices`, {
      waitUntil: 'networkidle2',
    });
    if (!(await clickByText(adminPage, 'register device')))
      throw new Error('no Register device button');
    await adminPage.waitForSelector('.MuiDialog-root input', { visible: true });
    await adminPage.type('.MuiDialog-root input', `${stamp}-kiosk`);
    await clickByText(adminPage, 'register device', '.MuiDialog-root');
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
    if (!activationCode) throw new Error('no activation code');
    await clickByText(adminPage, 'done', '.MuiDialog-root');
    await sleep(500);

    log('--- [admin] Rooms -> New room (defaults untouched)');
    await adminPage.goto(`${args.baseUrl}/admin/rooms`, {
      waitUntil: 'networkidle2',
    });
    if (!(await clickByText(adminPage, 'new room')))
      throw new Error('no New room button');
    await adminPage.waitForSelector('.MuiDialog-root input', { visible: true });
    await adminPage.type('.MuiDialog-root input', `${stamp}-room`);
    const dialogTimezone = await adminPage.evaluate(() => {
      const inputs = [...document.querySelectorAll('.MuiDialog-root input')];
      return inputs.map((i) => i.value);
    });
    await adminPage.click(
      '.MuiDialog-root [role="combobox"], .MuiDialog-root .MuiSelect-select',
    );
    const picked = await until(
      () =>
        clickByText(adminPage, `${stamp}-kiosk`, '.MuiPopover-root, .MuiMenu-root'),
      15_000,
    );
    if (!picked) throw new Error('device never appeared in the source picker');
    await sleep(300);
    await clickByText(adminPage, 'create', '.MuiDialog-root');
    await adminPage.waitForSelector('input[type="text"]', { visible: true });
    await adminPage.type('input[type="text"]', `${stamp}-room`);
    await until(
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
    if (!roomUid) throw new Error('room creation failed');

    const afterCreate = await serverSnapshot(adminPage, roomUid);
    record('ROOM_CREATED_VIA_NEW_ROOM_DIALOG', {
      roomUid,
      dialogInputValues: dialogTimezone,
      autoSessionEnabled: afterCreate.autoSessionEnabled,
      timezone: afterCreate.roomTimezone,
    });
    findings.roomCreatedAutoSessionEnabled = afterCreate.autoSessionEnabled;
    findings.roomTimezone = afterCreate.roomTimezone;

    // ---- kiosk: activate, then LEAVE IT PARKED AND IDLE -----------------
    log('--- [kiosk] activating and parking on /kiosk/');
    kiosk = await launch([
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ]);
    await kiosk
      .defaultBrowserContext()
      .overridePermissions(args.baseUrl, ['microphone']);
    kioskPage = await kiosk.newPage();
    kioskPage.setDefaultTimeout(20_000);

    const kioskNet = {
      sourceSocketOpen: false,
      sourceSocketAt: null,
      sourceSockets: [], // timestamps, so a *second* activation is detectable
      binaryFrames: 0,
      schedulePolls: [], // {t, status, sessions}
    };
    const kioskCdp = await kioskPage.createCDPSession();
    await kioskCdp.send('Network.enable');
    kioskPage.on('framenavigated', (frame) => {
      if (frame === kioskPage.mainFrame())
        kioskCdp.send('Network.enable').catch(() => {});
    });
    kioskCdp.on('Network.webSocketCreated', (e) => {
      if (e.url.includes('/transcription-stream/')) {
        kioskNet.sourceSocketOpen = true;
        kioskNet.sourceSocketAt ??= Date.now();
        kioskNet.sourceSockets.push(Date.now());
      }
    });
    kioskCdp.on('Network.webSocketFrameSent', (e) => {
      if (e.response.opcode === 2) kioskNet.binaryFrames++;
    });
    kioskCdp.on('Network.responseReceived', (e) => {
      if (!e.response.url.includes('my-schedule')) return;
      const entry = { t: Date.now(), status: e.response.status, sessions: null };
      kioskNet.schedulePolls.push(entry);
      if (e.response.status === 200) {
        kioskCdp
          .send('Network.getResponseBody', { requestId: e.requestId })
          .then((r) => {
            try {
              const parsed = JSON.parse(r.body);
              entry.sessions = (parsed.sessions ?? []).map((s) => ({
                uid: s.uid.slice(0, 8),
                type: s.type,
                start: s.effectiveStart,
                end: s.effectiveEnd,
              }));
              entry.version = parsed.roomScheduleVersion;
            } catch {
              /* body may already be gone */
            }
          })
          .catch(() => {});
      }
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
    if (!needsActivation) throw new Error('kiosk did not offer activation form');
    await kioskPage.type('input', activationCode);
    await clickByText(kioskPage, 'activate');
    const activated = await until(
      () =>
        kioskPage.evaluate(
          () => !document.body.innerText.includes('not registered'),
        ),
      30_000,
    );
    if (!activated) throw new Error('kiosk activation failed');
    await sleep(3000);
    record('KIOSK_PARKED_IDLE', {
      kiosk: (await kioskState(kioskPage)).text,
      schedulePolls: kioskNet.schedulePolls.length,
    });
    screenshots.push(
      await shot(kioskPage, args.screenshotDir, args.prefix, '00-kiosk-parked-idle'),
    );

    // ================= Phase A: create the window, defaults untouched =====
    log('--- [admin] scheduling page -> New window');
    await adminPage.goto(`${args.baseUrl}/admin/rooms/${roomUid}/scheduling`, {
      waitUntil: 'networkidle2',
    });
    await sleep(1500);
    screenshots.push(
      await shot(
        adminPage,
        args.screenshotDir,
        args.prefix,
        '01-scheduling-page-before',
      ),
    );

    if (!(await clickByText(adminPage, 'new window')))
      throw new Error('no New window button');
    await adminPage.waitForSelector('.MuiDialog-root input[type="time"]', {
      visible: true,
    });

    // Local 00:00-23:59 daily: an occurrence that unambiguously covers the
    // next several hours, so nothing about the window's *design* is in doubt.
    const t1 = await setInput(
      adminPage,
      '.MuiDialog-root input[type="time"]',
      '00:00',
      0,
    );
    const t2 = await setInput(
      adminPage,
      '.MuiDialog-root input[type="time"]',
      '23:59',
      1,
    );
    if (!t1 || !t2) throw new Error('could not set the local time fields');

    // Days of week: all seven. MUI's Select opens on *mousedown*, so this must
    // be a real Puppeteer click, not element.click() (which does nothing and
    // then makes the following Escape close the whole dialog).
    await adminPage.click('.MuiDialog-root [role="combobox"]');
    const menuOpen = await until(
      () =>
        adminPage.evaluate(
          () =>
            !!document.querySelector(
              '.MuiMenu-root li, .MuiPopover-root li[role="option"]',
            ),
        ),
      5000,
      200,
    );
    if (!menuOpen) throw new Error('days-of-week menu never opened');
    for (const d of ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']) {
      const hit = await adminPage.evaluate((day) => {
        const items = [
          ...document.querySelectorAll('.MuiMenu-root li, .MuiPopover-root li'),
        ];
        const el = items.find((i) => (i.innerText ?? '').trim() === day);
        if (!el) return false;
        el.click();
        return true;
      }, d);
      if (!hit) throw new Error(`day option ${d} not found`);
      await sleep(120);
    }
    await adminPage.keyboard.press('Escape');
    await sleep(500);
    const dialogStillOpen = await adminPage.evaluate(
      () => !!document.querySelector('.MuiDialog-root'),
    );
    if (!dialogStillOpen)
      throw new Error('the dialog closed while picking days of week');

    // Active start: the earliest the dialog permits, i.e. the next whole
    // minute in the browser's local zone (it rejects anything <= now).
    const activeStartLocal = await adminPage.evaluate(() => {
      const d = new Date(Date.now() + 75_000);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    });
    const okStart = await setInput(
      adminPage,
      '.MuiDialog-root input[type="datetime-local"]',
      activeStartLocal,
      0,
    );
    if (!okStart) throw new Error('could not set the Active start field');
    await sleep(300);
    screenshots.push(
      await shot(
        adminPage,
        args.screenshotDir,
        args.prefix,
        '02-new-window-dialog-filled',
      ),
    );
    const dialogText = await adminPage.evaluate(
      () =>
        (
          document.querySelector('.MuiDialog-root')?.innerText ?? ''
        ).replace(/\s+/g, ' '),
    );
    record('NEW_WINDOW_DIALOG_FILLED', {
      activeStartLocal,
      browserTz: await adminPage.evaluate(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
      dialogMentionsAutoSessionsDisabled: /auto-?session/i.test(dialogText),
      dialogText: dialogText.slice(0, 400),
    });

    const saveClicked = await clickByText(adminPage, 'save', '.MuiDialog-root');
    if (!saveClicked) throw new Error('no Save button in the window dialog');
    const dialogClosed = await until(
      () => adminPage.evaluate(() => !document.querySelector('.MuiDialog-root')),
      20_000,
    );
    const toastText = await adminPage.evaluate(() => {
      const nodes = [...document.querySelectorAll('[role="alert"],[role="status"]')];
      return nodes.map((n) => (n.innerText ?? '').trim()).filter(Boolean);
    });
    record('WINDOW_SAVE_CLICKED', { dialogClosed: !!dialogClosed, toastText });
    await sleep(1500);
    screenshots.push(
      await shot(
        adminPage,
        args.screenshotDir,
        args.prefix,
        '03-scheduling-page-after-window',
      ),
    );

    const phaseA = await watchHops(
      adminPage,
      kioskPage,
      kioskNet,
      roomUid,
      args.phaseAWaitSeconds,
      'A',
      record,
    );
    findings.phaseA = phaseA;
    screenshots.push(
      await shot(kioskPage, args.screenshotDir, args.prefix, '04-kiosk-after-phaseA'),
    );

    // ================= Phase B: flip Auto-sessions ON in the UI ===========
    log('--- [admin] flipping the Auto-sessions switch ON');
    await adminPage.goto(`${args.baseUrl}/admin/rooms/${roomUid}/scheduling`, {
      waitUntil: 'networkidle2',
    });
    await adminPage.waitForSelector('input[type="checkbox"]', { visible: true });
    // NB: the app bar carries its own "Show UUIDs" MUI Switch, and it is first
    // in document order — a bare `.MuiSwitch-input` selector toggles that one
    // instead, silently. Scope to the card that actually says "Auto-sessions".
    const marked = await adminPage.evaluate(() => {
      const cards = [...document.querySelectorAll('.MuiPaper-root')];
      const card = cards.find(
        (c) =>
          (c.innerText ?? '').includes('Auto-sessions') &&
          !!c.querySelector('.MuiSwitch-input'),
      );
      if (!card) return 'no-card';
      const sw = card.querySelector('.MuiSwitch-input');
      if (sw.checked) return 'already-on';
      sw.id = 'research-auto-switch';
      return 'marked';
    });
    if (marked === 'marked') await adminPage.click('#research-auto-switch');
    await sleep(2500);
    const toggleToast = await adminPage.evaluate(() =>
      [...document.querySelectorAll('[role="alert"],[role="status"]')]
        .map((n) => (n.innerText ?? '').trim())
        .filter(Boolean),
    );
    const afterToggle = await serverSnapshot(adminPage, roomUid);
    record('AUTO_SESSIONS_TOGGLE', {
      marked,
      toggleToast,
      autoSessionEnabled: afterToggle.autoSessionEnabled,
      roomScheduleVersion: afterToggle.roomScheduleVersion,
    });
    if (afterToggle.autoSessionEnabled !== true)
      throw new Error('the Auto-sessions switch did not turn on server-side');
    screenshots.push(
      await shot(
        adminPage,
        args.screenshotDir,
        args.prefix,
        '05-scheduling-page-auto-enabled',
      ),
    );

    const phaseB = await watchHops(
      adminPage,
      kioskPage,
      kioskNet,
      roomUid,
      args.phaseBWaitSeconds,
      'B',
      record,
    );
    findings.phaseB = phaseB;
    screenshots.push(
      await shot(kioskPage, args.screenshotDir, args.prefix, '06-kiosk-after-phaseB'),
    );

    // ================= Phase C: real captions ============================
    if (!args.skipCaptions && phaseB.kioskLeftIdle !== null) {
      log('--- [kiosk] enabling the microphone');
      let streaming = false;
      for (let attempt = 1; attempt <= 4 && !streaming; attempt++) {
        const before = kioskNet.binaryFrames;
        await clickByText(kioskPage, 'microphone');
        await sleep(4000);
        streaming = kioskNet.binaryFrames > before + 5;
        log(`    attempt ${attempt}: frames ${before} -> ${kioskNet.binaryFrames}`);
      }
      record('KIOSK_STREAMING', { streaming, frames: kioskNet.binaryFrames });

      const snap = await serverSnapshot(adminPage, roomUid);
      const live = sessionCoveringNow(snap);
      if (live) {
        await adminPage.goto(`${args.baseUrl}/admin/sessions/${live.uid}`, {
          waitUntil: 'networkidle2',
        });
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
        record('JOIN_URL', { sessionUid: live.uid, joinUrl });
        screenshots.push(
          await shot(
            adminPage,
            args.screenshotDir,
            args.prefix,
            '07-admin-auto-session-detail',
          ),
        );
        if (joinUrl) {
          client = await launch();
          clientPage = await client.newPage();
          clientPage.setDefaultTimeout(20_000);
          await clientPage.goto(joinUrl, {
            waitUntil: 'networkidle2',
            timeout: 60_000,
          });
          const joined = await until(
            () =>
              clientPage.evaluate(
                () => !document.body.innerText.includes('Join Session'),
              ),
            60_000,
          );
          const transcript = await until(
            () =>
              clientPage.evaluate(() => {
                const l = document.querySelector('[role="log"]');
                const t = l ? (l.innerText ?? '').trim() : '';
                return t.length > 0 ? t : null;
              }),
            120_000,
            2000,
          );
          record('VIEWER', {
            joined: !!joined,
            transcriptChars: transcript ? transcript.length : 0,
            sample: transcript ? transcript.slice(0, 120) : null,
          });
          findings.captions = {
            joined: !!joined,
            transcript: transcript ? transcript.slice(0, 200) : null,
          };
          screenshots.push(
            await shot(
              clientPage,
              args.screenshotDir,
              args.prefix,
              '08-viewer-captions',
            ),
          );
          screenshots.push(
            await shot(
              kioskPage,
              args.screenshotDir,
              args.prefix,
              '09-kiosk-streaming',
            ),
          );
        }
      }
    }
    // ============ Phase D: a *future* window, switch already ON ===========
    // The demo scenario proper: the room is already auto-enabled, the kiosk is
    // parked, and the operator schedules a window that starts a minute from
    // now. Tests the kiosk's UPCOMING -> ACTIVE timer, not just its reaction to
    // a session that already covers "now".
    log('--- [admin] phase D: deleting the window, then re-creating it dated forward');
    await adminPage.goto(`${args.baseUrl}/admin/rooms/${roomUid}/scheduling`, {
      waitUntil: 'networkidle2',
    });
    await sleep(1500);
    await adminPage.evaluate(() => {
      const rows = [...document.querySelectorAll('tbody tr')];
      const row = rows.find((r) => (r.innerText ?? '').includes('SUN, MON'));
      const del = [...(row?.querySelectorAll('button') ?? [])].find((b) =>
        /delete/i.test(b.textContent ?? ''),
      );
      del?.click();
    });
    await sleep(700);
    await clickByText(adminPage, 'delete', '.MuiDialog-root');
    const gone = await until(
      async () => (await serverSnapshot(adminPage, roomUid)).windows.length === 0,
      30_000,
      2000,
    );
    const afterDelete = await serverSnapshot(adminPage, roomUid);
    record('PHASE_D_WINDOW_DELETED', {
      windowsGone: !!gone,
      windows: afterDelete.windows.length,
      sessions: afterDelete.sessions.length,
      kiosk: (await kioskState(kioskPage)).text,
    });
    await sleep(5000);

    log('--- [admin] phase D: New window with activeStart ~75s out');
    if (!(await clickByText(adminPage, 'new window')))
      throw new Error('no New window button (phase D)');
    await adminPage.waitForSelector('.MuiDialog-root input[type="time"]', {
      visible: true,
    });
    await setInput(adminPage, '.MuiDialog-root input[type="time"]', '00:00', 0);
    await setInput(adminPage, '.MuiDialog-root input[type="time"]', '23:59', 1);
    await adminPage.click('.MuiDialog-root [role="combobox"]');
    await until(
      () =>
        adminPage.evaluate(
          () => !!document.querySelector('.MuiMenu-root li, .MuiPopover-root li'),
        ),
      5000,
      200,
    );
    for (const d of ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']) {
      await adminPage.evaluate((day) => {
        const items = [
          ...document.querySelectorAll('.MuiMenu-root li, .MuiPopover-root li'),
        ];
        items.find((i) => (i.innerText ?? '').trim() === day)?.click();
      }, d);
      await sleep(120);
    }
    await adminPage.keyboard.press('Escape');
    await sleep(400);
    const futureStartLocal = await adminPage.evaluate(() => {
      const d = new Date(Date.now() + 75_000);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    });
    await setInput(
      adminPage,
      '.MuiDialog-root input[type="datetime-local"]',
      futureStartLocal,
      0,
    );
    await sleep(300);
    const savedD = await clickByText(adminPage, 'save', '.MuiDialog-root');
    if (!savedD) throw new Error('no Save button (phase D)');
    await sleep(2000);
    const dSnap = await serverSnapshot(adminPage, roomUid);
    record('PHASE_D_WINDOW_CREATED', {
      futureStartLocal,
      autoSessionEnabled: dSnap.autoSessionEnabled,
      windows: dSnap.windows,
      sessions: dSnap.sessions.slice(0, 2),
    });

    const phaseD = await watchHops(
      adminPage,
      kioskPage,
      kioskNet,
      roomUid,
      240,
      'D',
      record,
    );
    findings.phaseD = phaseD;
    screenshots.push(
      await shot(kioskPage, args.screenshotDir, args.prefix, '10-kiosk-after-phaseD'),
    );
  } catch (err) {
    record('HARNESS_ERROR', { error: err?.stack || String(err) });
    for (const [name, page] of [
      ['zz-failure-admin', adminPage],
      ['zz-failure-kiosk', kioskPage],
      ['zz-failure-client', clientPage],
    ]) {
      if (!page) continue;
      try {
        screenshots.push(await shot(page, args.screenshotDir, args.prefix, name));
      } catch {
        /* page gone */
      }
    }
  } finally {
    if (adminPage && roomUid && !args.keepRoom) {
      try {
        await adminPage.goto(`${args.baseUrl}/admin/rooms/${roomUid}`, {
          waitUntil: 'networkidle2',
        });
        await clickByText(adminPage, 'delete room');
        await sleep(700);
        await clickByText(adminPage, 'delete', '.MuiDialog-root');
        await sleep(1500);
        log(`--- deleted room ${roomUid}`);
      } catch (e) {
        log(`--- room cleanup failed: ${e.message}`);
      }
      try {
        await adminPage.goto(`${args.baseUrl}/admin/devices`, {
          waitUntil: 'networkidle2',
        });
        await sleep(1000);
      } catch {
        /* ignore */
      }
    } else if (roomUid) {
      log(`--- kept room ${roomUid}`);
    }
    for (const b of [client, kiosk, admin]) if (b) await b.close().catch(() => {});
  }

  console.log('\n=== TIMELINE ===');
  console.log(JSON.stringify(timeline, null, 2));
  console.log('\n=== FINDINGS ===');
  console.log(JSON.stringify(findings, null, 2));
  console.log('\n=== SCREENSHOTS ===');
  for (const s of screenshots) console.log(`  ${s}`);
}

/**
 * Watch all four hops for `seconds`, logging every 10s, and return the first
 * time each hop fired (or null). The hops, in order:
 *   1 window stored server-side
 *   2 a session covering "now" exists server-side
 *   3 the kiosk's my-schedule long-poll delivered a session
 *   4 the kiosk transitioned out of idle / opened its source socket
 */
async function watchHops(
  adminPage,
  kioskPage,
  kioskNet,
  roomUid,
  seconds,
  phase,
  record,
) {
  const t0 = Date.now();
  const socketBaseline = kioskNet.sourceSockets.length;
  const out = {
    windowStored: null,
    sessionExists: null,
    sessionCoveringNow: null,
    kioskLongPollDeliveredSession: null,
    kioskLeftIdle: null,
    kioskSourceSocket: null,
    lastSnapshot: null,
    lastKioskText: null,
  };
  const pollsAtStart = kioskNet.schedulePolls.length;
  while ((Date.now() - t0) / 1000 < seconds) {
    const snap = await serverSnapshot(adminPage, roomUid);
    const covering = sessionCoveringNow(snap);
    const ktext = (await kioskState(kioskPage)).text;
    const delivered = kioskNet.schedulePolls
      .slice(pollsAtStart)
      .find((p) => Array.isArray(p.sessions) && p.sessions.length > 0);
    const el = Math.round((Date.now() - t0) / 1000);

    if (out.windowStored === null && snap.windows.length > 0) out.windowStored = el;
    if (out.sessionExists === null && snap.sessions.length > 0)
      out.sessionExists = el;
    if (out.sessionCoveringNow === null && covering) out.sessionCoveringNow = el;
    if (out.kioskLongPollDeliveredSession === null && delivered)
      out.kioskLongPollDeliveredSession = el;
    const newSocket = kioskNet.sourceSockets.length > socketBaseline;
    if (out.kioskLeftIdle === null && !/Inactive, waiting/i.test(ktext))
      out.kioskLeftIdle = el;
    if (out.kioskSourceSocket === null && newSocket) out.kioskSourceSocket = el;

    out.lastSnapshot = snap;
    out.lastKioskText = ktext;

    log(
      `  [phase ${phase} t+${el}s] autoEnabled=${snap.autoSessionEnabled} ` +
        `version=${snap.roomScheduleVersion} windows=${snap.windows.length} ` +
        `sessions=${snap.sessions.length} coveringNow=${covering ? covering.uid.slice(0, 8) : 'none'} ` +
        `polls=${kioskNet.schedulePolls.length} deliveredSessions=${delivered ? delivered.sessions.length : 0} ` +
        `sourceSocket=${kioskNet.sourceSocketOpen} kiosk="${ktext.slice(0, 60)}"`,
    );

    if (out.kioskSourceSocket !== null && out.sessionCoveringNow !== null) {
      log(`  [phase ${phase}] all hops fired; stopping early at t+${el}s`);
      break;
    }
    await sleep(3_000);
  }
  record(`PHASE_${phase}_RESULT`, {
    windowStoredAtSec: out.windowStored,
    sessionExistsAtSec: out.sessionExists,
    sessionCoveringNowAtSec: out.sessionCoveringNow,
    kioskLongPollDeliveredSessionAtSec: out.kioskLongPollDeliveredSession,
    kioskLeftIdleAtSec: out.kioskLeftIdle,
    kioskSourceSocketAtSec: out.kioskSourceSocket,
    autoSessionEnabled: out.lastSnapshot?.autoSessionEnabled,
    windows: out.lastSnapshot?.windows,
    sessions: out.lastSnapshot?.sessions,
    kioskText: out.lastKioskText,
    schedulePollCount: kioskNet.schedulePolls.length,
  });
  return out;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(2);
});
