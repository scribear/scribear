/**
 * Authenticated / past-the-lock-screen axe scan.
 *
 * The plain axe-scan.mjs only ever sees each SPA's initial locked state (client =
 * Join-Session modal, kiosk = activation form, standalone = provider UI). This
 * driver runs against the mock backend (tools/a11y/mock-server.mjs) and *drives*
 * each app past its gate — entering a join code, activating the kiosk, opening the
 * settings drawer — then runs axe on those real interactive states. This reaches
 * the caption view (the P0 `role="log"` region), the settings drawer, and the
 * preference controls that the plain crawler can never get to.
 *
 * Prereq: start the mock first (it proxies the deployed frontend bundles and fakes
 * the session/device API + caption WebSocket):
 *
 *   node tools/a11y/mock-server.mjs &
 *   node tools/a11y/axe-scan-authed.mjs [baseUrl]      # default http://127.0.0.1:8090
 *
 * Per-state JSON is written to tools/a11y/results/authed-<state>.json.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AxePuppeteer } from '@axe-core/puppeteer';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:8090';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const outDir = join(__dirname, 'results');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(`No Chrome/Chromium found. Set CHROME_PATH. Tried: ${CHROME_CANDIDATES.join(', ')}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const impactRank = { critical: 0, serious: 1, moderate: 2, minor: 3 };

let totalViolations = 0;

async function runAxe(page, label) {
  const results = await new AxePuppeteer(page).withTags(WCAG_TAGS).analyze();
  const violations = results.violations.sort(
    (a, b) => impactRank[a.impact] - impactRank[b.impact],
  );
  totalViolations += violations.length;
  process.stdout.write(`\n--- state: ${label} (${page.url()}) ---\n`);
  if (violations.length === 0) process.stdout.write('  No axe violations detected.\n');
  for (const v of violations) {
    process.stdout.write(
      `  [${(v.impact ?? 'n/a').toUpperCase()}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        `        ${v.helpUrl}\n`,
    );
    for (const node of v.nodes.slice(0, 4)) {
      process.stdout.write(`        - ${node.target.join(' ')}\n`);
    }
  }
  writeFileSync(join(outDir, `authed-${label}.json`), JSON.stringify(results, null, 2));
}

// Wait for the SPA root to render, plus a settle for late async paints.
async function waitForApp(page) {
  await page
    .waitForFunction(
      () => {
        const root = document.getElementById('root');
        return root && root.children.length > 0;
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  await sleep(1200);
}

// Click the first element matching `tag` whose text contains `text`. Returns
// true if something was clicked. Tolerant — used for best-effort UI driving.
async function clickByText(page, tag, text) {
  const handle = await page.evaluateHandle(
    (t, needle) =>
      [...document.querySelectorAll(t)].find((el) =>
        (el.textContent ?? '').trim().includes(needle),
      ) ?? null,
    tag,
    text,
  );
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
}

// Open the settings drawer. Prefer the labelled menu button; fall back to the
// button wrapping the MUI MenuIcon (older bundles have no aria-label yet).
async function openMenu(page) {
  try {
    await page.click('button[aria-label="Open Menu"]', { timeout: 2000 });
    return true;
  } catch {
    const clicked = await page.evaluate(() => {
      const icon = document.querySelector('svg[data-testid="MenuIcon"]');
      const btn = icon?.closest('button');
      if (!btn) return false;
      btn.click();
      return true;
    });
    return clicked;
  }
}

async function openDrawerAndScan(page, label) {
  try {
    const opened = await openMenu(page);
    if (!opened) {
      process.stdout.write(`  (skipped ${label}: no menu button found)\n`);
      return;
    }
    await sleep(600);
    // Expand every collapsible settings group so the controls inside are scanned.
    for (let i = 0; i < 8; i += 1) {
      const expanded = await clickByText(page, 'button[aria-expanded="false"]', '');
      if (!expanded) break;
      await sleep(150);
    }
    await sleep(400);
    await runAxe(page, label);
  } catch (err) {
    process.stdout.write(`  (skipped ${label}: ${err.message})\n`);
  }
}

async function scanClient(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/client/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await waitForApp(page);
  await runAxe(page, 'client-1-join-modal');

  // Enter a join code and submit — the mock accepts any code.
  await page.type('input', 'MOCK01', { delay: 20 });
  await page.click('button[type="submit"]');
  // Wait for the caption live-region (modal closed, lifecycle ACTIVE).
  await page.waitForSelector('[role="log"]', { timeout: 10000 }).catch(() => {});
  await sleep(2500); // let a couple of captions stream into the log region
  await runAxe(page, 'client-2-captions');

  await openDrawerAndScan(page, 'client-3-settings-drawer');
  await page.close();
}

async function scanKiosk(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/kiosk/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await waitForApp(page);
  await sleep(1500); // get-my-device 401 -> activation form
  await runAxe(page, 'kiosk-1-activation');

  // Activate: any code; the mock sets the DEVICE_TOKEN cookie and the app re-inits.
  try {
    await page.type('input', 'MOCK-ACTIVATE', { delay: 20 });
    await clickByText(page, 'button', 'Activate');
    await sleep(3000);
    await runAxe(page, 'kiosk-2-registered');
  } catch (err) {
    process.stdout.write(`  (skipped kiosk-2-registered: ${err.message})\n`);
  }

  await openDrawerAndScan(page, 'kiosk-3-settings-drawer');
  await page.close();
}

async function scanStandalone(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/standalone/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await waitForApp(page);
  await runAxe(page, 'standalone-1-initial');
  await openDrawerAndScan(page, 'standalone-2-settings-drawer');
  await page.close();
}

async function main() {
  // Fail fast with a helpful message if the mock isn't running.
  try {
    const res = await fetch(`${BASE_URL}/__mock/health`);
    if (!res.ok) throw new Error(`health ${res.status}`);
  } catch (err) {
    process.stderr.write(
      `Mock server not reachable at ${BASE_URL} (${err.message}).\n` +
        `Start it first:  node tools/a11y/mock-server.mjs\n`,
    );
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: resolveChrome(),
    headless: true,
    acceptInsecureCerts: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });
  try {
    await scanClient(browser);
    await scanKiosk(browser);
    await scanStandalone(browser);
  } finally {
    await browser.close();
  }
  process.stdout.write(`\nTotal violation rule-groups across authed states: ${totalViolations}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err && err.stack ? err.stack : err)}\n`);
  process.exit(1);
});
