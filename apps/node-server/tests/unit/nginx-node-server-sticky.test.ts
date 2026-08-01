import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

import {
  TRANSCRIPTION_STREAM_CLIENT_ROUTE,
  TRANSCRIPTION_STREAM_SOURCE_ROUTE,
} from '@scribear/node-server-schema';

/**
 * Guards the sticky-routing assumption this workspace is built on but cannot
 * enforce from inside itself.
 *
 * `TranscriptionOrchestratorService`'s class doc states it outright: "Sticky
 * URL routing pins all connections for a given sessionUid to one Node Server
 * instance, so the singleton state for a session is always co-located with the
 * source connections feeding it." That state - the EventBus, the upstream
 * transcription socket, the pending-chunk map - is per-process. A viewer routed
 * to a different instance than its source subscribes to a channel nothing
 * publishes on and receives no transcripts: no error, no close, no banner, just
 * an empty caption view.
 *
 * Nothing checked it. The `upstream node-server` block had no balancing
 * directive at all, so stickiness held only because the service happens to run
 * one replica; `docker compose up --scale node-server=2` would have broken
 * captioning with nothing anywhere naming the cause.
 *
 * Same reasoning and same precedent as `nginx-status-not-public.test.ts`: the
 * requirement belongs to this workspace, the config that satisfies it lives in
 * `infra/`, and a comment is weaker than a failing test.
 */
const NGINX_CONF_PATH = fileURLToPath(
  new URL('../../../../infra/scribear-nginx/nginx.conf', import.meta.url),
);

/** The `upstream node-server { ... }` block, exactly as nginx reads it. */
function nodeServerUpstreamBlock(conf: string): string {
  const start = conf.indexOf('upstream node-server {');
  expect(
    start,
    'nginx.conf has no `upstream node-server { ... }` block.',
  ).toBeGreaterThanOrEqual(0);
  const end = conf.indexOf('\n    }', start);
  expect(end).toBeGreaterThan(start);
  return conf.slice(start, end);
}

describe('nginx sticky-routes node-server by session uid', (it) => {
  it('balances the node-server upstream on the session-uid variable', () => {
    // Arrange
    const conf = readFileSync(NGINX_CONF_PATH, 'utf8');

    // Act
    const block = nodeServerUpstreamBlock(conf);

    // Assert
    expect(
      block,
      'The node-server upstream has no `hash` directive, so nginx will ' +
        'round-robin. Every connection for a session must reach the same ' +
        'instance: the orchestrator state is per-process, and a viewer on a ' +
        'different instance than its source silently receives no transcripts.',
    ).toContain('hash $node_server_session_uid');
  });

  it('does not use `consistent`, which this nginx silently ignores on a resolve upstream', () => {
    // Arrange
    const conf = readFileSync(NGINX_CONF_PATH, 'utf8');

    // Act
    const block = nodeServerUpstreamBlock(conf);

    // Assert - measured against nginx:1.29.7-alpine3.23 with two backends
    // behind one docker network alias. Requesting the same session uid
    // repeatedly: `hash $key consistent;` returned B A B A B A - plain
    // round-robin, the directive ignored - while `hash $key;` returned B B B B
    // B B and held two uids on two different peers across several `valid=5s`
    // re-resolutions. `nginx -t` passes on both and, at one replica, both
    // behave identically, so nothing but this test would catch the swap.
    //
    // Ketama is the better algorithm on its merits (a peer joining remaps ~1/N
    // of sessions rather than most of them), which is exactly why someone will
    // eventually try to add it back. It does not work here. If you have a
    // newer nginx where it does, re-run that measurement before changing this.
    expect(
      block,
      '`consistent` is silently ignored when the upstream server is a ' +
        '`resolve` name in this nginx build: the upstream falls back to ' +
        'round-robin and stickiness is lost with no error and no log line.',
    ).not.toContain('consistent');
  });

  it('keys the hash off the session uid segment of both stream routes', () => {
    // Arrange - derived from the route definitions rather than hard-coded, so
    // moving the routes fails this test instead of leaving the map matching a
    // prefix that no longer exists.
    const conf = readFileSync(NGINX_CONF_PATH, 'utf8');
    const prefix = '/api/node-server/v1/transcription-stream/';
    expect(TRANSCRIPTION_STREAM_SOURCE_ROUTE.url).toBe(
      `${prefix}:sessionUid/source`,
    );
    expect(TRANSCRIPTION_STREAM_CLIENT_ROUTE.url).toBe(
      `${prefix}:sessionUid/client`,
    );

    // Act
    const mapStart = conf.indexOf('map $uri $node_server_session_uid {');
    expect(
      mapStart,
      'nginx.conf defines no $node_server_session_uid map, so the `hash` ' +
        'directive has nothing to hash on.',
    ).toBeGreaterThanOrEqual(0);
    const map = conf.slice(mapStart, conf.indexOf('\n    }', mapStart));

    // Assert - the regex captures the segment straight after the shared
    // prefix, which is the session uid on both routes.
    expect(map).toContain(`~^${prefix}(?<sess_uid>[^/]+)`);
    // `$uri`, not `$request_uri`: normalised, decoded and query-free, so a
    // trailing `?x=1` cannot send a second connection for the same session to
    // a different instance.
    expect(map.startsWith('map $uri ')).toBe(true);
  });
});
