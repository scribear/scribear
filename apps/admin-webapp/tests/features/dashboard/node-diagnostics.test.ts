import { describe, expect } from 'vitest';

import {
  deriveCloseGroups,
  deriveDiagnosticsRollup,
  deriveHandshakeTally,
  deriveHostFindings,
  deriveNodeFindings,
} from '#src/features/dashboard/node-diagnostics';

import { buildHost, buildNode } from './node-fixtures';

describe('deriveHandshakeTally', (it) => {
  it('keeps timeouts out of the rejection total', () => {
    // node-server's `recordAuthTimeout` does not also call
    // `recordAuthFailure`, so folding the two would make the panel's own
    // numbers stop adding up.
    const tally = deriveHandshakeTally(
      buildNode({
        summary: {
          ...buildNode().summary,
          authSuccessTotal: 8,
          authTimeoutsTotal: 5,
        },
        authFailures: [{ reason: 'invalid-token', count: 2 }],
      }),
    );

    expect(tally.failureTotal).toBe(2);
    expect(tally.timeoutsTotal).toBe(5);
    expect(tally.successTotal).toBe(8);
  });

  it('sorts reasons by count so the dominant failure is first', () => {
    const tally = deriveHandshakeTally(
      buildNode({
        authFailures: [
          { reason: 'token-expired', count: 1 },
          { reason: 'invalid-token', count: 9 },
          { reason: 'missing-scope', count: 4 },
        ],
      }),
    );

    expect(tally.byReason.map((r) => r.reason)).toEqual([
      'invalid-token',
      'missing-scope',
      'token-expired',
    ]);
  });

  it('reports a null ratio when no credential has ever been presented', () => {
    const tally = deriveHandshakeTally(
      buildNode({
        summary: { ...buildNode().summary, authSuccessTotal: 0 },
      }),
    );

    // Not zero: "nothing has tried" and "nothing has failed" are different
    // answers to the runbook's dropping-vs-never-connected question.
    expect(tally.rejectRatio).toBeNull();
  });

  it('computes the ratio against successes, the denominator node-server ships for it', () => {
    const tally = deriveHandshakeTally(
      buildNode({
        summary: { ...buildNode().summary, authSuccessTotal: 1 },
        authFailures: [{ reason: 'invalid-token', count: 3 }],
      }),
    );

    expect(tally.rejectRatio).toBe(0.75);
  });
});

describe('deriveCloseGroups', (it) => {
  it('groups by role and splits each group by initiator', () => {
    const groups = deriveCloseGroups(
      buildNode({
        wsCloses: [
          {
            code: 1006,
            reason: '',
            role: 'source',
            initiator: 'peer',
            count: 41,
          },
          {
            code: 1008,
            reason: 'invalid-token',
            role: 'source',
            initiator: 'server',
            count: 2,
          },
          {
            code: 1001,
            reason: '',
            role: 'client',
            initiator: 'peer',
            count: 7,
          },
        ],
      }),
    );

    expect(groups.map((g) => g.role)).toEqual(['source', 'client']);
    const source = groups[0];
    expect(source?.peerTotal).toBe(41);
    expect(source?.serverTotal).toBe(2);
    expect(source?.total).toBe(43);
    // The rows keep `initiator` — the label the tally exists for.
    expect(source?.rows[0]).toMatchObject({ initiator: 'peer', count: 41 });
  });

  it('omits a role with no closes rather than showing it as zero', () => {
    // An absent label combination has never occurred; node-server omits it,
    // and rendering an empty "Viewer connections — 0 closes" row would invent
    // a fact about viewers that have simply never connected.
    const groups = deriveCloseGroups(
      buildNode({
        wsCloses: [
          {
            code: 1000,
            reason: 'session-ended',
            role: 'source',
            initiator: 'server',
            count: 3,
          },
        ],
      }),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.role).toBe('source');
  });
});

describe('deriveNodeFindings', (it) => {
  it('names a signing-key mismatch when every handshake was rejected as invalid-token', () => {
    // PLAN §8 question 4. `verifyAuth` returns `invalid-token` when
    // `SessionTokenService.verify` fails the HMAC, which is exactly what a
    // SESSION_TOKEN_SIGNING_KEY disagreement produces.
    const findings = deriveNodeFindings(
      buildNode({
        summary: { ...buildNode().summary, authSuccessTotal: 0 },
        authFailures: [{ reason: 'invalid-token', count: 47 }],
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('error');
    expect(findings[0]?.headline).toMatch(/never accepted a session token/i);
    expect(findings[0]?.cause).toMatch(/signing-key mismatch/i);
    expect(findings[0]?.nextAction).toMatch(/SESSION_TOKEN_SIGNING_KEY/);
  });

  it('does not claim a key mismatch when the rejections are a different reason', () => {
    const findings = deriveNodeFindings(
      buildNode({
        summary: { ...buildNode().summary, authSuccessTotal: 0 },
        authFailures: [{ reason: 'token-expired', count: 6 }],
      }),
    );

    expect(findings[0]?.level).toBe('error');
    expect(findings[0]?.cause).not.toMatch(/signing-key mismatch/i);
    expect(findings[0]?.cause).toMatch(/expiry had already passed/i);
  });

  it('warns without claiming currency when most, but not all, handshakes were rejected', () => {
    const findings = deriveNodeFindings(
      buildNode({
        summary: { ...buildNode().summary, authSuccessTotal: 2 },
        authFailures: [{ reason: 'invalid-token', count: 8 }],
      }),
    );

    expect(findings[0]?.level).toBe('warning');
    expect(findings[0]?.headline).toMatch(/80%/);
    // These are lifetime totals; saying "authentication is failing now" would
    // be the exact class of bug this panel exists to remove.
    expect(findings[0]?.cause).toMatch(/totals since the process started/i);
  });

  it('says nothing at all about a node whose handshakes are healthy', () => {
    expect(deriveNodeFindings(buildNode())).toEqual([]);
  });

  it('flags a device acting on a stale schedule', () => {
    const findings = deriveNodeFindings(
      buildNode({
        summary: {
          ...buildNode().summary,
          endedSessionRegistrationsTotal: 4,
        },
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.headline).toMatch(/already ended/i);
    expect(findings[0]?.cause).toMatch(/mySchedule long-poll/i);
  });

  it('treats an absent optional counter as unreported, not as zero activity', () => {
    // `endedSessionRegistrationsTotal` is optional on the wire so an older
    // publisher does not fail the strict read-side check.
    expect(deriveNodeFindings(buildNode())).toEqual([]);
  });
});

describe('deriveHostFindings', (it) => {
  it('names the keys the host does serve alongside the refusal count', () => {
    const findings = deriveHostFindings(
      buildHost({ invalidProviderKeyRejects: 3 }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('error');
    expect(findings[0]?.cause).toMatch(/whisper/);
    // Not a capacity problem, so "wait and retry" would be wrong advice.
    expect(findings[0]?.cause).toMatch(/no amount of retrying/i);
  });

  it('is silent when the host has refused nothing', () => {
    expect(deriveHostFindings(buildHost())).toEqual([]);
  });
});

describe('deriveDiagnosticsRollup', (it) => {
  it('sums handshakes and closes across nodes and counts findings', () => {
    const rollup = deriveDiagnosticsRollup(
      [
        buildNode({
          nodeInstanceId: 'node-a',
          wsCloses: [
            {
              code: 1006,
              reason: '',
              role: 'source',
              initiator: 'peer',
              count: 4,
            },
          ],
        }),
        buildNode({
          nodeInstanceId: 'node-b',
          processUid: 'proc-2',
          summary: { ...buildNode().summary, authSuccessTotal: 0 },
          authFailures: [{ reason: 'invalid-token', count: 5 }],
          wsCloses: [
            {
              code: 1001,
              reason: '',
              role: 'client',
              initiator: 'peer',
              count: 9,
            },
          ],
        }),
      ],
      [buildHost({ invalidProviderKeyRejects: 1 })],
    );

    expect(rollup.authSuccessTotal).toBe(10);
    expect(rollup.authFailureTotal).toBe(5);
    expect(rollup.sourceClosesTotal).toBe(4);
    expect(rollup.clientClosesTotal).toBe(9);
    expect(rollup.findingCount).toBe(2);
  });
});
