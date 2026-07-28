import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

/**
 * The standalone microphone meter ships as one self-contained HTML file whose
 * DSP and UI are inline `<script>` blocks. This build copies that file into the
 * bundle (see the `copy-audio-meter-page` plugin in `vite.config.ts`), so
 * operators reach it at `/admin/audio-meter.html` — behind the nginx location
 * that sets a Content-Security-Policy.
 *
 * The SPA's policy (`script-src 'self'`) blocks inline script, and a blocked
 * meter fails **silently**: the page renders in full, "Start metering" does
 * nothing, and every readout stays an em-dash. So nginx gives that one path its
 * own policy whose `script-src` names the sha256 of each script the page ships.
 *
 * Those hashes live in another workspace than the file they pin, and any edit
 * to the page invalidates them. This suite recomputes them from the shipped
 * page and fails if the two have drifted apart — which is the only automated
 * signal that would otherwise exist between "someone edits the meter" and "an
 * operator opens a dead page".
 *
 * It lives in this workspace rather than in admin-webapp — which is the app
 * that ships the page — because reading the two files needs `node:fs`, and
 * admin-webapp's tsconfig pins `types: ["vite/client"]` on purpose. This is
 * already the workspace that reads the shared page from disk (see
 * `audio-meter-dsp.test.ts`), and it serves the same file itself.
 */

const PAGE_PATH = fileURLToPath(
  new URL(
    '../../../../libs/audio-meter-page/audio-meter.html',
    import.meta.url,
  ),
);
const NGINX_CONF_PATH = fileURLToPath(
  new URL('../../../../infra/scribear-nginx/nginx.conf', import.meta.url),
);

const LOCATION = 'location = /admin/audio-meter.html {';

/** Text of every `<script>` element in the page, in document order. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1] ?? '',
  );
}

/** The CSP `add_header` value from a single nginx location block. */
function cspOfLocation(conf: string, header: string): string {
  const start = conf.indexOf(header);
  expect(start, `${header} is missing from nginx.conf`).toBeGreaterThanOrEqual(
    0,
  );
  // Locations in this file are indented four spaces inside `server`, so the
  // block ends at the first line that closes at that indentation.
  const end = conf.indexOf('\n        }', start);
  const block = conf.slice(start, end);
  const csp = /add_header Content-Security-Policy "([^"]+)"/.exec(block);
  expect(csp, `no Content-Security-Policy in ${header}`).not.toBeNull();
  return csp![1]!;
}

describe('audio-meter page CSP', (it) => {
  const html = readFileSync(PAGE_PATH, 'utf8');
  const conf = readFileSync(NGINX_CONF_PATH, 'utf8');

  it('allows the sha256 of every script the page actually ships', () => {
    // Arrange: the hashes CSP checks are of the element's exact text, so they
    // change on any edit inside a <script> block — including whitespace.
    const expected = inlineScripts(html).map(
      (source) =>
        `sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}`,
    );
    expect(
      expected.length,
      'the page should still carry its DSP and UI scripts',
    ).toBe(2);

    // Act
    const csp = cspOfLocation(conf, LOCATION);

    // Assert: naming the regeneration command in the message matters — whoever
    // trips this is editing the meter page, not thinking about nginx.
    for (const hash of expected) {
      expect(
        csp,
        `nginx.conf does not allow '${hash}'.\n` +
          "Recompute after editing the page and paste into infra/scribear-nginx/nginx.conf's " +
          `${LOCATION.slice(0, -2)} block:\n` +
          '  node -e \'const f=require("fs"),c=require("crypto");' +
          'for(const m of f.readFileSync("libs/audio-meter-page/audio-meter.html","utf8")' +
          '.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/g))' +
          'console.log("sha256-"+c.createHash("sha256").update(m[1]).digest("base64"))\'',
      ).toContain(hash);
    }
  });

  it('pins those scripts by hash rather than reopening inline execution', () => {
    // A future "fix" for a hash mismatch could be to add 'unsafe-inline', which
    // would make this page's policy weaker than the SPA's beside it. The hashes
    // are what keep the relaxation to exactly the two scripts in the repo.
    const csp = cspOfLocation(conf, LOCATION);
    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';

    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // The page assembles its AudioWorklet module from its own DSP source as a
    // blob; without this it silently falls back to a main-thread
    // ScriptProcessorNode. Working, but deprecated and on the UI thread.
    expect(scriptSrc).toContain('blob:');
  });

  it('keeps the meter on its own policy without loosening the SPA', () => {
    // The SPA policy must stay strict: it is the one with a login form, an API
    // and a session behind it. Only the static meter page gets the exception.
    const spaCsp = cspOfLocation(conf, 'location /admin/ {');

    expect(spaCsp).toContain("script-src 'self';");
    expect(spaCsp).not.toContain('sha256-');
    expect(spaCsp).not.toContain('blob:');
  });

  it('serves the meter from admin-webapp, not from a second copy', () => {
    // An exact-match location wins over the /admin/ prefix regardless of order,
    // so nginx replaces the whole matched URI — the upstream path has to be
    // spelled out or the request arrives at admin-webapp as "/" and the SPA
    // answers with index.html, which looks like a working page.
    const start = conf.indexOf(LOCATION);
    const block = conf.slice(start, conf.indexOf('\n        }', start));

    expect(block).toContain('proxy_pass http://admin-webapp/audio-meter.html;');
  });
});
