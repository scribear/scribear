import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

/**
 * Guards the onsite-only access gate the same way
 * nginx-status-not-public.test.ts (node-server) and
 * nginx-session-config-stream-not-public.test.ts (session-manager) guard
 * their own routes: nginx.conf is the only place this policy is enforced,
 * and a comment asking not to delete a location block is weaker than a
 * failing test. See 2026-08-02-01-PLAN-OnsiteAccess.md (scribear2, not this
 * repo) for the full design.
 *
 * This lives here, not in one of the app workspaces the way the two
 * precedents above do, because the gate spans every app's routes at once -
 * there is no single owning service the way STATUS_ROUTE belongs to
 * node-server.
 */
const NGINX_CONF_PATH = fileURLToPath(
  new URL('../../nginx.conf', import.meta.url),
);

const ONSITE_DENIED_MESSAGE =
  'Onsite only; captions are not served to the internet.';

// Every location this gate must guard, and the exact denial each one must
// perform when $onsite = 0. Frontend surfaces redirect to /extlanding so a
// person sees an explanation; APIs 403 with a message, since the caller is
// assumed to be a program, not a person reading a landing page.
const GATED_LOCATIONS: {
  name: string;
  header: string;
  denial: 'api' | 'frontend';
}[] = [
  {
    name: 'session-manager API',
    header: 'location /api/session-manager/ {',
    denial: 'api',
  },
  { name: 'admin API', header: 'location /api/admin/ {', denial: 'api' },
  {
    name: 'admin fleet SSE stream',
    header: 'location = /api/admin/v1/fleet/stream {',
    denial: 'api',
  },
  {
    name: 'node-server API (transcription-stream WebSocket)',
    header: 'location /api/node-server/ {',
    denial: 'api',
  },
  { name: 'client-webapp', header: 'location /client/ {', denial: 'frontend' },
  { name: 'kiosk-webapp', header: 'location /kiosk/ {', denial: 'frontend' },
  {
    name: 'standalone-webapp',
    header: 'location /standalone/ {',
    denial: 'frontend',
  },
  {
    name: 'admin-webapp audio meter',
    header: 'location = /admin/audio-meter.html {',
    denial: 'frontend',
  },
  { name: 'admin-webapp', header: 'location /admin/ {', denial: 'frontend' },
];

describe('nginx onsite-only access gate', (it) => {
  const conf = readFileSync(NGINX_CONF_PATH, 'utf8');

  it('includes the mounted/defaulted allowlist that defines $onsite', () => {
    expect(conf).toContain('include /etc/nginx/onsite/config/allowlist.conf;');
  });

  it('serves /extlanding without an $onsite check - it must stay reachable from anywhere', () => {
    // Arrange
    const start = conf.indexOf('location = /extlanding {');
    expect(
      start,
      'nginx.conf has no /extlanding location. This route is the devops ' +
        'preview page (see 2026-08-02-01-PLAN-OnsiteAccess.md §3) and every ' +
        'gated frontend route redirects to it - it must exist and must never ' +
        'itself be gated.',
    ).toBeGreaterThanOrEqual(0);
    const block = conf.slice(start, conf.indexOf('\n        }', start));

    // Assert
    expect(block).not.toContain('$onsite');
  });

  for (const { name, header, denial } of GATED_LOCATIONS) {
    it(`gates ${name} behind $onsite`, () => {
      // Arrange
      const start = conf.indexOf(header);
      expect(
        start,
        `nginx.conf has no location block starting with "${header}". If ` +
          'this route was renamed or restructured, this test needs updating ' +
          'alongside it - do not just delete the assertion.',
      ).toBeGreaterThanOrEqual(0);
      const block = conf.slice(start, conf.indexOf('\n        }', start));

      // Assert - the gate is the first thing in the block, before proxy_pass
      // ever runs, and denies in the shape this route's audience expects.
      const ifIndex = block.indexOf('if ($onsite = 0)');
      const proxyIndex = block.indexOf('proxy_pass');
      expect(
        ifIndex,
        `${name}'s location block is missing the "if ($onsite = 0) { ... }" gate.`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        ifIndex,
        `${name}'s $onsite gate must run before proxy_pass, not after - ` +
          'otherwise the request already reached the upstream before being denied.',
      ).toBeLessThan(proxyIndex);

      if (denial === 'api') {
        expect(block).toContain(`return 403 "${ONSITE_DENIED_MESSAGE}`);
      } else {
        expect(block).toContain('return 302 /extlanding;');
      }
    });
  }

  it('gates every $onsite `if` the one way nginx documents as safe inside a location', () => {
    // Every real gate in this file must be exactly `if ($onsite = 0) {
    // return ...; }` - a single `return`, nothing else - per
    // https://www.nginx.com/resources/wiki/start/topics/depth/ifisevil/. A
    // future edit that adds a second directive inside one of these `if`
    // blocks would reintroduce exactly the class of bug that page warns
    // about, so this checks the *shape* of every gate, not just that the
    // string "$onsite" appears somewhere (which a comment - like the one
    // explaining this exact rule, a few lines above the first gate - would
    // also satisfy).
    const gatePattern =
      /if \(\$onsite = 0\) \{\n\s+return (403 "[^"]*"|302 \/extlanding);\n\s+\}/g;
    const matches = [...conf.matchAll(gatePattern)];

    expect(matches).toHaveLength(GATED_LOCATIONS.length);
  });
});
