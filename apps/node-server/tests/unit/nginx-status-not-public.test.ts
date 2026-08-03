import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

import { STATUS_ROUTE } from '@scribear/node-server-schema';

/**
 * Guards the one thing about `/status` that is not enforced by any code in this
 * workspace: that the shipped reverse-proxy config does not publish it.
 *
 * `status.schema.ts` says the endpoint "must not be exposed through the public
 * reverse proxy", and for a long time nothing checked that - nginx's
 * `location /api/node-server/` prefix block forwarded the entire prefix, and the
 * endpoint answered 200 through the public origin to anyone holding the service
 * key. A comment in nginx.conf asking not to delete the rule is weaker than a
 * failing test, and this suite already owns the route definition, so the
 * assertion lives here rather than beside the config. Precedent:
 * monitoring-sidecar's audio-meter-csp.test.ts reads the same file for the same
 * kind of reason.
 */
const NGINX_CONF_PATH = fileURLToPath(
  new URL('../../../../infra/scribear-nginx/nginx.conf', import.meta.url),
);

describe('nginx does not publish /status', (it) => {
  it('shadows the status route with a non-forwarding location block', () => {
    // Arrange
    const conf = readFileSync(NGINX_CONF_PATH, 'utf8');

    // The route as nginx must see it. Derived from STATUS_ROUTE rather than
    // hard-coded, so moving the endpoint fails this test instead of silently
    // leaving the block guarding a path that no longer exists.
    const path = STATUS_ROUTE.url;
    expect(path).toBe('/api/node-server/v1/status');

    // Act - the block, from its `location` line to the first line that closes
    // at the four-space indentation every location in this file sits at.
    const start = conf.indexOf(`location ^~ ${path} {`);
    expect(
      start,
      `nginx.conf has no internal-only location block for ${path}. ` +
        'Do not delete it as redundant: without it the /api/node-server/ ' +
        'prefix block forwards this endpoint to the public internet, which ' +
        'status.schema.ts says must not happen.',
    ).toBeGreaterThanOrEqual(0);
    const block = conf.slice(start, conf.indexOf('\n        }', start));

    // Assert - it terminates the request rather than proxying it, and does so
    // without confirming the route exists (404, not 403 or 401).
    expect(block).not.toContain('proxy_pass');
    expect(block).toContain('return 404;');
  });
});
