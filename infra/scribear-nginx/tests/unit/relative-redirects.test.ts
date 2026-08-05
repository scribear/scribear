import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

/**
 * Pins `absolute_redirect off` on the TLS server, for the same reason
 * `onsite-gate.test.ts` pins the gate: nginx.conf is the only place this
 * lives, and its absence is invisible in the one environment anybody
 * checks.
 *
 * nginx expands a redirect written as a path into an absolute URL built
 * from `$host`, which carries no port. In production, where the stack is
 * served on 443, the expansion is indistinguishable from the path - so a
 * deletion of this directive passes every production smoke test. On any
 * origin published elsewhere (the dev/iso stack at :8443) the expanded
 * Location moves the browser to port 443 of the same host: a different
 * stack on the same machine, or nothing listening at all. Observed against
 * real containers before this was added.
 */
const NGINX_CONF_PATH = fileURLToPath(
  new URL('../../nginx.conf', import.meta.url),
);

// The `return`s that this directive governs: nginx generates each one
// itself, and each is written as a path rather than an absolute URL. Every
// one of these would be rewritten against $host without it.
const PATH_REDIRECTS = [
  'return 308 /client/;',
  'return 308 /grafana/;',
  'return 302 /client/;',
  'return 302 /extlanding;',
];

describe('nginx relative redirects', (it) => {
  const conf = readFileSync(NGINX_CONF_PATH, 'utf8');

  it('turns off absolute_redirect on the TLS server', () => {
    // Arrange - scope the search to the 443 server, so the directive cannot
    // satisfy this test from the plain-HTTP server block, where it would do
    // nothing (that listener's only redirect is an absolute URL already).
    const tlsServer = conf.slice(conf.indexOf('listen 443 ssl;'));

    // Assert
    expect(
      tlsServer,
      'nginx.conf no longer sets `absolute_redirect off` on the TLS ' +
        'server. Without it every path redirect below is rewritten against ' +
        '$host, which drops a non-default port and sends the client to a ' +
        'different origin than the one it reached. This is invisible on a ' +
        'stack served from 443 - do not "verify" its removal there.',
    ).toContain('absolute_redirect off;');
  });

  it('still writes every self-generated redirect as a path, not an absolute URL', () => {
    // Arrange - the directive only has an effect on redirects written as
    // paths. A future edit that "helpfully" spells one out as
    // https://$host/... would opt that route back out of the fix without
    // touching the directive above, so both halves are pinned.
    const tlsServer = conf.slice(conf.indexOf('listen 443 ssl;'));

    // Assert
    for (const redirect of PATH_REDIRECTS) {
      expect(
        tlsServer,
        `nginx.conf no longer contains \`${redirect}\`. If that route was ` +
          'renamed, update this list; if its target was rewritten as an ' +
          'absolute URL, it has silently opted out of `absolute_redirect ' +
          'off` and will drop the port again.',
      ).toContain(redirect);
    }
    expect(
      tlsServer,
      'A redirect target in the TLS server is now an absolute URL built ' +
        'from $host. That is exactly what `absolute_redirect off` exists to ' +
        'avoid here - see the comment on that directive.',
    ).not.toMatch(/return 30[128] https?:\/\/\$host/);
  });
});
