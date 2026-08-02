/**
 * Sweep up any leftover `auto-*` rooms/devices this harness's own
 * `finally` cleanup didn't catch (e.g. the process was killed mid-run rather
 * than crashing cleanly). Deletes through the admin console's own API with
 * its CSRF token.
 *
 * Usage: node cleanup.mjs [baseUrl] [envFile]
 *
 * KNOWN ISSUE: CSRF extraction from `/auth/me` has previously 403'd here
 * without a fix being tracked down (the harness's own per-run cleanup, which
 * drives the delete through the real UI instead, does not have this
 * problem). If this reports `"csrf": false` or 403s on delete, fall back to
 * deleting stray `auto-*` rooms/devices by hand from the admin console, or
 * via the DB directly on an isolated stack.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'https://localhost:8443';
const ENVFILE =
  process.argv[3] ?? join(homedir(), 'scribear2', 'deployment-iso', '.env');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error('No Chrome/Chromium found. Set CHROME_PATH.');

const env = readFileSync(ENVFILE, 'utf8');
const line = env.split('\n').find((l) => l.startsWith('ADMIN_LOCAL_CREDENTIALS='));
const [user, ...rest] = line.slice('ADMIN_LOCAL_CREDENTIALS='.length).trim().split(/\s+/);
const pass = rest.join(' ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  acceptInsecureCerts: true,
  args: ['--no-sandbox', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2' });
await page.waitForSelector('input[autocomplete="username"]', { visible: true });
await page.type('input[autocomplete="username"]', user);
await page.type('input[type="password"]', pass);
await page.click('button[type="submit"]');
await sleep(4000);

const result = await page.evaluate(async () => {
  const get = async (p) => {
    const r = await fetch(`/api/admin/v1${p}`, { credentials: 'include' });
    return r.json();
  };
  // The CSRF token the SPA uses is minted per session at /auth/session.
  const sess = await get('/auth/me');
  const csrf = sess?.data?.csrfToken ?? null;
  const post = async (p, body) => {
    const r = await fetch(`/api/admin/v1${p}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const rooms = await get('/rooms/list');
  const devices = await get('/devices/list');
  const out = { csrf: !!csrf, rooms: [], devices: [] };
  for (const r of rooms?.data?.items ?? []) {
    if (!r.name.startsWith('auto-')) continue;
    out.rooms.push([r.name, (await post('/rooms/delete', { roomUid: r.uid })).status]);
  }
  for (const d of devices?.data?.items ?? []) {
    if (!d.name.startsWith('auto-')) continue;
    out.devices.push([
      d.name,
      (await post('/devices/delete', { deviceUid: d.uid })).status,
    ]);
  }
  return out;
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
