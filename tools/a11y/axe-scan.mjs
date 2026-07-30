/**
 * WCAG 2.1 AA automated scan of the ScribeAR webapps using axe-core driven by
 * a headless Chrome (puppeteer-core against the system browser).
 *
 * Usage:
 *   node tools/a11y/axe-scan.mjs [baseUrl]
 *
 * baseUrl defaults to https://localhost (the deploy_local nginx stack). The
 * script scans /client/, /kiosk/, and /standalone/, printing a per-route
 * summary of axe violations and writing the full JSON to tools/a11y/results/.
 *
 * These are SPAs, so the scan waits for the React root to render before
 * running axe. Automated tools catch ~30-40% of WCAG issues; pair this with
 * the manual review in archived-plans/2026-07-24-02-PLAN-WCAG-Frontends.md.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AxePuppeteer } from '@axe-core/puppeteer';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.argv[2] ?? 'https://localhost';
const ROUTES = ['/client/', '/kiosk/', '/standalone/'];
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Prefer an installed Chrome; fall back to the common Debian/Ubuntu paths.
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

async function scanRoute(browser, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  // SPAs: wait until the React root has mounted actual content.
  await page
    .waitForFunction(
      () => {
        const root = document.getElementById('root');
        return root && root.children.length > 0;
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  // Small settle for late async render (spinner -> content).
  await new Promise((r) => setTimeout(r, 1500));

  const results = await new AxePuppeteer(page).withTags(WCAG_TAGS).analyze();
  await page.close();
  return results;
}

async function main() {
  const executablePath = resolveChrome();
  const outDir = join(__dirname, 'results');
  mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    acceptInsecureCerts: true, // deploy_local uses a self-signed cert
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });

  let totalViolations = 0;
  const impactRank = { critical: 0, serious: 1, moderate: 2, minor: 3 };

  try {
    for (const route of ROUTES) {
      const url = `${BASE_URL}${route}`;
      process.stdout.write(`\n=== ${url} ===\n`);
      let results;
      try {
        results = await scanRoute(browser, url);
      } catch (err) {
        process.stdout.write(`  ERROR scanning route: ${err.message}\n`);
        continue;
      }
      const violations = results.violations.sort(
        (a, b) => impactRank[a.impact] - impactRank[b.impact],
      );
      totalViolations += violations.length;

      if (violations.length === 0) {
        process.stdout.write('  No axe violations detected.\n');
      }
      for (const v of violations) {
        process.stdout.write(
          `  [${(v.impact ?? 'n/a').toUpperCase()}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
            `        ${v.helpUrl}\n`,
        );
        for (const node of v.nodes.slice(0, 4)) {
          process.stdout.write(`        - ${node.target.join(' ')}\n`);
        }
      }

      const slug = route.replaceAll('/', '') || 'root';
      writeFileSync(
        join(outDir, `${slug}.json`),
        JSON.stringify(results, null, 2),
      );
    }
  } finally {
    await browser.close();
  }

  process.stdout.write(
    `\nTotal violation rule-groups across routes: ${totalViolations}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${String(err && err.stack ? err.stack : err)}\n`);
  process.exit(1);
});
