/**
 * Admin console scheduling/session regression checks.
 *
 * Drives a real headless Chromium against a running stack's admin console
 * (/admin/) and asserts the behaviours around the room scheduling / session
 * interface that were found broken or missing. It is a regression scaffold:
 * each check names the bug it pins, so a fix that changes the behaviour fails
 * loudly here and the test gets updated alongside it.
 *
 * Usage:
 *   node tools/admin-scheduling-e2e/admin-scheduling-e2e.mjs [options]
 *
 * Options:
 *   --base-url <url>   default https://localhost  (self-signed certs accepted)
 *   --username <u>     default engrit             (ADMIN_LOCAL_CREDENTIALS)
 *   --password <p>     default engrit-dev-pass-0123
 *   --json             machine-readable result on stdout
 *   --keep-room        do not delete the provisioned room at the end
 *
 * Requires a running stack (deployment/compose.yml) with the admin console
 * served at <base-url>/admin/. Chrome is auto-detected the same way
 * tools/e2e-audio does: CHROME_PATH, then the usual system locations.
 *
 * What it checks (each maps to a finding in the scheduling/session review):
 *
 *   1. NO_ACTIVE_SESSION_IN_ROOM_VIEW
 *      An active on-demand session exists, but the room detail page shows no
 *      "current/active session" anywhere. There is no field for it: the Room
 *      entity carries no session reference and no admin endpoint returns one.
 *
 *   2. ON_DEMAND_SESSION_NOT_ON_SCHEDULING_PAGE
 *      The scheduling page lists schedule *definitions* and auto-session
 *      *windows* only. A live on-demand session (a `sessions` row with no
 *      parent schedule) is invisible to it.
 *
 *   3. ALREADY_RUNNING_WITH_NONE_VISIBLE
 *      Creating a second on-demand session is rejected 409
 *      ANOTHER_SESSION_ACTIVE, but the scheduling page shows no active session
 *      to explain the conflict — the operator is blocked with no recourse from
 *      the UI.
 *
 *   4. NO_ADMIN_SESSION_LIST_ENDPOINT
 *      No admin BFF route lists sessions or returns a room's active session.
 *      GET /api/admin/v1/sessions/list is 404; the only session read is by UID.
 *
 *   5. SCHEDULE_BEYOND_90_DAY_WINDOW_INVISIBLE
 *      The scheduling page queries [now, now+90d). A schedule whose activeStart
 *      is >90 days out is stored and valid but never listed — clipped by the
 *      `active_start <= to` filter, not by end date.
 *
 *   6. NO_AUTO_REFRESH
 *      The scheduling page has no poll/interval. A session created server-side
 *      after page load never appears until the page is reloaded manually.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    `No Chrome/Chromium found. Set CHROME_PATH. Tried: ${CHROME_CANDIDATES.join(', ')}`,
  );
}

function parseArgs(argv) {
  const a = {
    baseUrl: 'https://localhost',
    username: 'engrit',
    password: 'engrit-dev-pass-0123',
    json: false,
    keepRoom: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--json') a.json = true;
    else if (f === '--keep-room') a.keepRoom = true;
    else if (f === '--base-url') a.baseUrl = argv[++i];
    else if (f === '--username') a.username = argv[++i];
    else if (f === '--password') a.password = argv[++i];
  }
  return a;
}

/**
 * Read the admin local credentials from deployment/.env when present, so the
 * defaults above can be overridden without flags. Mirrors the way e2e-audio
 * reads the admin key.
 */
function credsFromEnv(args) {
  try {
    const env = readFileSync(new URL('../../deployment/.env', import.meta.url), 'utf8');
    const line = env.split('\n').find((l) => l.startsWith('ADMIN_LOCAL_CREDENTIALS='));
    if (line) {
      const val = line.slice('ADMIN_LOCAL_CREDENTIALS='.length).trim();
      const [user, ...rest] = val.split(/\s+/);
      if (user && rest.length) return { ...args, username: user, password: rest.join(' ') };
    }
  } catch {
    // .env optional
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A single assertion result. `bug` ties it back to a finding. */
function check(name, bug, ok, detail = '') {
  return { name, bug, ok, detail };
}

/**
 * BFF API call run inside the browser page so the admin session cookie and CSRF
 * token are handled by the browser context. Returns { status, body }.
 */
async function bff(page, method, path, { body, csrf } = {}) {
  return page.evaluate(
    async (method, path, body, csrf) => {
      const res = await fetch(`/api/admin/v1${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      let parsed = null;
      const text = await res.text();
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed };
    },
    method,
    path,
    body ?? null,
    csrf ?? null,
  );
}

/** Wait for a visible MUI Snackbar toast whose Alert text contains `needle`. */
async function waitForToast(page, needle, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = await page.evaluate((needle) => {
      const alerts = [...document.querySelectorAll('.MuiAlert-message, [role="alert"]')];
      const el = alerts.find((e) => (e.textContent ?? '').includes(needle));
      return el ? el.textContent.trim() : null;
    }, needle);
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}

/** Visible text of the page, whitespace-collapsed, for "does it mention X" checks. */
async function bodyText(page) {
  return page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
}

async function main() {
  const args = credsFromEnv(parseArgs(process.argv.slice(2)));
  const log = (...m) => {
    if (!args.json) console.log(...m);
  };
  const results = [];
  let browser, page, roomUid, deviceUid, scheduleUid;

  try {
    browser = await puppeteer.launch({
      executablePath: resolveChrome(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
      acceptInsecureCerts: true,
    });
    page = await browser.newPage();
    page.setDefaultTimeout(15_000);

    // ---- Login through the UI (real auth path) ----
    log('--- logging in to /admin/');
    await page.goto(`${args.baseUrl}/admin/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[autocomplete="username"]', { visible: true });
    await page.type('input[autocomplete="username"]', args.username);
    await page.type('input[type="password"]', args.password);
    await page.click('button[type="submit"]');
    // The dashboard renders a health tile once authed.
    await page.waitForFunction(() => window.location.pathname.startsWith('/admin'), {
      timeout: 10_000,
    });
    await page.waitForFunction(
      () => !document.querySelector('input[autocomplete="username"]'),
      { timeout: 10_000 },
    );
    log('--- authed');

    // Fetch the CSRF token; all BFF mutations need it.
    const me = await bff(page, 'GET', '/auth/me');
    const csrf = me.body?.data?.csrfToken;
    if (!csrf) throw new Error('No CSRF token from /auth/me');

    // ---- Provision a uniquely-named device + room via the BFF ----
    const stamp = `pw-${process.pid}-${Math.floor(Date.now() / 1000)}`;
    const dev = await bff(page, 'POST', '/devices/register', {
      body: { name: `${stamp}-src` },
      csrf,
    });
    deviceUid = dev.body?.data?.deviceUid;
    if (!deviceUid) throw new Error(`device register failed: ${JSON.stringify(dev.body)}`);

    const room = await bff(page, 'POST', '/rooms/create', {
      body: {
        name: `${stamp}-room`,
        timezone: 'UTC',
        autoSessionEnabled: false,
        sourceDeviceUids: [deviceUid],
      },
      csrf,
    });
    roomUid = room.body?.data?.uid;
    if (!roomUid) throw new Error(`room create failed: ${JSON.stringify(room.body)}`);
    log(`--- provisioned room ${roomUid} (device ${deviceUid})`);

    // Create ONE on-demand session via the BFF. With no following scheduled
    // session, scheduled_end_time is NULL → the session is active forever.
    const sess = await bff(page, 'POST', '/sessions/create-on-demand', {
      body: {
        roomUid,
        name: `${stamp}-ondemand`,
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      },
      csrf,
    });
    const sessionUid = sess.body?.data?.uid;
    if (!sessionUid)
      throw new Error(`on-demand create failed: ${JSON.stringify(sess.body)}`);
    log(`--- created on-demand session ${sessionUid} (active, no end time)`);

    // ============================================================
    // CHECK 1: NO_ACTIVE_SESSION_IN_ROOM_VIEW
    // Desired: the room detail page shows the active session (name + "active").
    // ============================================================
    log('--- check 1: room view shows the active session');
    await page.goto(`${args.baseUrl}/admin/rooms/${roomUid}`, {
      waitUntil: 'networkidle2',
    });
    await page.waitForSelector('h1', { visible: true });
    const roomText = await bodyText(page);
    const showsActiveSession =
      /active session/i.test(roomText) &&
      roomText.includes(`${stamp}-ondemand`);
    results.push(
      check(
        'room detail page shows the active session',
        'NO_ACTIVE_SESSION_IN_ROOM_VIEW',
        showsActiveSession,
        showsActiveSession
          ? 'Room view renders an Active session card naming the live session.'
          : 'Room view does not surface the active session.',
      ),
    );

    // ============================================================
    // CHECK 2: ON_DEMAND_SESSION_NOT_ON_SCHEDULING_PAGE
    // Desired: the scheduling page lists live session rows, including the
    // on-demand one (which has no parent schedule).
    // ============================================================
    log('--- check 2: scheduling page lists the on-demand session');
    await page.goto(`${args.baseUrl}/admin/rooms/${roomUid}/scheduling`, {
      waitUntil: 'networkidle2',
    });
    await page.waitForSelector('h2', { visible: true });
    const schedText = await bodyText(page);
    const showsSessionName = schedText.includes(`${stamp}-ondemand`);
    results.push(
      check(
        'scheduling page shows the live on-demand session',
        'ON_DEMAND_SESSION_NOT_ON_SCHEDULING_PAGE',
        showsSessionName,
        showsSessionName
          ? 'Scheduling page lists the on-demand session in the Sessions table.'
          : 'The active on-demand session does not appear on the scheduling page.',
      ),
    );

    // ============================================================
    // CHECK 3: ALREADY_RUNNING_WITH_NONE_VISIBLE
    // Try to start a second on-demand session from the UI. The server rejects
    // with 409 ANOTHER_SESSION_ACTIVE, surfaced as an error toast — while the
    // page still shows no active session to explain the conflict.
    // ============================================================
    log('--- check 3: second on-demand blocked, none visible');
    // Open the "Start a session now" dialog.
    const opened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /start a session now/i.test(b.textContent || ''),
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (!opened) throw new Error('could not open the on-demand dialog');
    await page.waitForSelector('.MuiDialog-root input', { visible: true });
    // Type a name into the dialog's first (Name) input.
    await page.type('.MuiDialog-root input', `${stamp}-ondemand-2`);
    // Click the "Start session" button inside the dialog.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.MuiDialog-root button')].find((b) =>
        /start session/i.test(b.textContent || ''),
      );
      btn?.click();
    });
    const conflictToast = await waitForToast(
      page,
      'currently active',
      10_000,
    );
    const schedTextAfter = await bodyText(page);
    // Desired behaviour: the page should surface the active session that is
    // causing the conflict, so the operator can find and end it. Today it does
    // not — the toast names the conflict but the page shows nothing.
    const pageShowsBlockingSession = schedTextAfter.includes(`${stamp}-ondemand`);
    results.push(
      check(
        'scheduling page shows the session blocking a new on-demand creation',
        'ALREADY_RUNNING_WITH_NONE_VISIBLE',
        pageShowsBlockingSession,
        (conflictToast
          ? `Conflict toast appeared: "${conflictToast}". `
          : 'No conflict toast appeared within 10s. ') +
          (pageShowsBlockingSession
            ? 'Page shows the blocking session.'
            : 'Page shows no active session to explain the conflict — operator is blocked.'),
      ),
    );
    // Close the dialog if still open (Cancel) so later steps start clean.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.MuiDialog-root button')].find((b) =>
        /cancel/i.test(b.textContent || ''),
      );
      btn?.click();
    });
    await sleep(300);

    // ============================================================
    // CHECK 4: NO_ADMIN_SESSION_LIST_ENDPOINT
    // Desired: a BFF route lists sessions for a room (200, not 404).
    // ============================================================
    log('--- check 4: admin session-list endpoint exists');
    const listRes = await bff(
      page,
      'GET',
      `/sessions/list?roomUid=${roomUid}`,
    );
    const endpointExists = listRes.status === 200;
    results.push(
      check(
        'an admin session-list endpoint exists',
        'NO_ADMIN_SESSION_LIST_ENDPOINT',
        endpointExists,
        `GET /sessions/list?roomUid=… → ${listRes.status} ` +
          `(200 = route present, 404 = absent). ` +
          `Room entity carries no session field by design; the active-session ` +
          `endpoint is checked implicitly by check 1.`,
      ),
    );

    // ============================================================
    // CHECK 5: SCHEDULE_BEYOND_90_DAY_WINDOW_INVISIBLE
    // A schedule with activeStart >90d out is stored but clipped by the
    // scheduling page's [now, now+90d) query.
    // ============================================================
    log('--- check 5: schedule beyond 90-day window is invisible');
    const farFuture = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString();
    const sch = await bff(page, 'POST', '/schedules/create', {
      body: {
        roomUid,
        name: `${stamp}-farschedule`,
        activeStart: farFuture,
        activeEnd: null,
        localStartTime: '09:00',
        localEndTime: '10:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      },
      csrf,
    });
    scheduleUid = sch.body?.data?.uid;
    const createdOk = !!scheduleUid;
    // Reload the scheduling page and see whether it lists the far-future schedule.
    await page.goto(`${args.baseUrl}/admin/rooms/${roomUid}/scheduling`, {
      waitUntil: 'networkidle2',
    });
    await page.waitForSelector('h2', { visible: true });
    const textAfterFar = await bodyText(page);
    const farListed = textAfterFar.includes(`${stamp}-farschedule`);
    results.push(
      check(
        'scheduling page lists a schedule starting >90 days out',
        'SCHEDULE_BEYOND_90_DAY_WINDOW_INVISIBLE',
        false,
        createdOk
          ? farListed
            ? 'unexpected: far-future schedule is listed (window may have widened)'
            : 'Confirmed: schedule created but not listed (activeStart beyond the 90d `to` bound).'
          : `schedule create failed: ${JSON.stringify(sch.body)}`,
      ),
    );

    // ============================================================
    // CHECK 6: NO_AUTO_REFRESH
    // Desired: the scheduling page polls the session list, so a session
    // created server-side after page load appears without a manual reload.
    // (Schedules are definitions and only reload on mutation; the poll covers
    // the live session rows, which is what changes underneath an operator.)
    // ============================================================
    log('--- check 6: scheduling page auto-refreshes sessions');
    // Create a second on-demand session server-side. The page is already open
    // on the scheduling view from check 5; the poll (15s) should pick it up.
    // We end the first session first so creation is not blocked.
    await bff(page, 'POST', '/sessions/end-early', {
      body: { sessionUid },
      csrf,
    });
    const sess2 = await bff(page, 'POST', '/sessions/create-on-demand', {
      body: {
        roomUid,
        name: `${stamp}-ondemand-refresh`,
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      },
      csrf,
    });
    const refreshSessionUid = sess2.body?.data?.uid;
    // Wait past the poll interval (15s) plus margin.
    let appearedWithoutReload = false;
    for (let i = 0; i < 40; i++) {
      const text = await bodyText(page);
      if (text.includes(`${stamp}-ondemand-refresh`)) {
        appearedWithoutReload = true;
        break;
      }
      await sleep(500);
    }
    results.push(
      check(
        'scheduling page refreshes when server state changes',
        'NO_AUTO_REFRESH',
        appearedWithoutReload,
        appearedWithoutReload
          ? 'New session appeared without a manual reload (poller working).'
          : 'New session did not appear within 20s — no auto-refresh.',
      ),
    );
    // Clean up the refresh session by ending it (room deletion cascades anyway).
    if (refreshSessionUid) {
      await bff(page, 'POST', '/sessions/end-early', {
        body: { sessionUid: refreshSessionUid },
        csrf,
      });
    }
  } catch (err) {
    results.push({
      name: 'harness',
      bug: 'HARNESS_ERROR',
      ok: false,
      detail: err?.stack || String(err),
    });
  } finally {
    // ---- Cleanup: delete schedules + room (cascades sessions/memberships) ----
    if (page && roomUid) {
      try {
        if (scheduleUid) {
          await bff(page, 'POST', '/schedules/delete', { body: { scheduleUid } });
        }
        if (!args.keepRoom) {
          const me = await bff(page, 'GET', '/auth/me');
          const csrf = me.body?.data?.csrfToken;
          await bff(page, 'POST', '/rooms/delete', { body: { roomUid }, csrf });
          log(`--- deleted room ${roomUid}`);
        } else {
          log(`--- kept room ${roomUid} (--keep-room)`);
        }
      } catch (e) {
        log('--- cleanup failed:', e.message);
      }
    }
    if (browser) await browser.close();
  }

  // ---- Report ----
  const failures = results.filter((r) => !r.ok);
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    log(`[${tag}] ${r.bug}: ${r.name}`);
    if (r.detail) log(`        ${r.detail}`);
  }
  const summary = {
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    results,
  };
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else log(`\n${summary.passed}/${summary.total} checks passed.`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
