import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

import { SESSION_CONFIG_STREAM_ROUTE } from '@scribear/session-manager-schema';

/**
 * Guards the one thing about `session-config-stream` that no code in this
 * workspace enforces: that the shipped reverse-proxy config does not publish it.
 *
 * The route is guarded by the *service* key rather than the admin key or a
 * device token, and that key's schema says it is "used by sibling services
 * (Session Stream Server) to consume internal APIs" - but nginx's
 * `location /api/session-manager/` prefix block forwarded the whole prefix, so
 * it was reachable from the internet. Its only consumer is node-server, which
 * reaches session-manager over the compose network
 * (`SESSION_MANAGER_BASE_URL=http://session-manager:80`) and never through
 * nginx. A comment asking not to delete the rule is weaker than a failing test.
 */
const NGINX_CONF_PATH = fileURLToPath(
  new URL('../../../../infra/scribear-nginx/nginx.conf', import.meta.url),
);

describe('nginx does not publish session-config-stream', (it) => {
  it('shadows the route prefix with a non-forwarding location block', () => {
    // Arrange
    const conf = readFileSync(NGINX_CONF_PATH, 'utf8');

    // Derived from the route definition rather than hard-coded, so moving the
    // endpoint fails this test instead of leaving the block guarding a path that
    // no longer exists. The `:sessionUid` segment is fastify's, not nginx's -
    // nginx matches the prefix above it.
    const prefix = SESSION_CONFIG_STREAM_ROUTE.url.replace(/:sessionUid$/, '');
    expect(prefix).toBe(
      '/api/session-manager/v1/schedule-management/session-config-stream/',
    );

    // Act
    const start = conf.indexOf(`location ^~ ${prefix} {`);
    expect(
      start,
      `nginx.conf has no internal-only location block for ${prefix}. ` +
        'Do not delete it as redundant: without it the /api/session-manager/ ' +
        'prefix block forwards this service-to-service route to the public ' +
        'internet.',
    ).toBeGreaterThanOrEqual(0);
    const block = conf.slice(start, conf.indexOf('\n        }', start));

    // Assert - terminates rather than proxies, and does not confirm the route
    // exists (404, not 403 or 401).
    expect(block).not.toContain('proxy_pass');
    expect(block).toContain('return 404;');
  });
});
