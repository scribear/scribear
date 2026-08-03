import type {
  CloseInitiator,
  ConnectionRole,
  NodeSnapshot,
  TranscriptionHostSnapshot,
  WsCloseTally,
} from '#src/lib/admin-api';

/**
 * Node-server and Transcription Service counter derivations for the fleet
 * panel (PLAN-VisibleErrors §4.1, §4.2). Every number these read has been
 * arriving in the browser on `FleetSnapshot.nodes` / `.transcriptionHosts`
 * every 5 s since the fleet view shipped, and nothing rendered any of it.
 *
 * **All of it is monotonic since the publishing process started.** Nothing here
 * is a rate and nothing here describes "now"; the rendering layer's job is to
 * keep saying so. Deriving a rate in the browser was considered and rejected —
 * see the note on {@link NodeFinding} — so every verdict below is phrased so it
 * stays true of a lifetime total.
 */

/**
 * What each `authFailures[].reason` from node-server's `verifyAuth` actually
 * means, in operator language. Sourced from
 * `apps/node-server/src/server/features/transcription-stream/transcription-stream.auth.ts`
 * and `session-token.service.ts`, not from the names.
 *
 * An **open set**: a reason that is not in here is rendered verbatim with no
 * gloss, which is the correct behaviour for a new reason shipped by a
 * node-server newer than this console.
 */
export const AUTH_FAILURE_REASON_HELP: Record<string, string> = {
  'invalid-token':
    'The token’s HMAC did not verify, or its payload failed the schema check. This is what a SESSION_TOKEN_SIGNING_KEY mismatch between session-manager and node-server looks like — session-manager is minting tokens node-server cannot verify.',
  'token-expired':
    'The token’s expiry had already passed when the socket authenticated — a client sitting on an old token, or clock skew between session-manager and node-server.',
  'session-mismatch':
    'The token was minted for a different session than the URL it was presented on.',
  'missing-scope':
    'The token lacks the scope this role requires — SEND_AUDIO for a source, RECEIVE_TRANSCRIPTIONS for a viewer.',
};

/** Operator-facing name for each `wsCloses[].role`. */
export const CONNECTION_ROLE_LABEL: Record<ConnectionRole, string> = {
  source: 'Source uplinks (the room’s microphone)',
  client: 'Viewer connections',
};

/**
 * Operator-facing name for each `wsCloses[].initiator`. Spelled out as words
 * rather than shown as a colour or an icon: `initiator` is the label the whole
 * tally exists for, and the two values mean genuinely different things about
 * who is at fault.
 */
export const CLOSE_INITIATOR_LABEL: Record<CloseInitiator, string> = {
  server: 'node-server closed it',
  peer: 'the far end closed it',
};

export interface HandshakeTally {
  /** Successful WebSocket auth handshakes since process start. */
  successTotal: number;
  /** Credential rejections, summed across reasons. Excludes timeouts. */
  failureTotal: number;
  /**
   * Connections that never sent `auth` inside the watchdog window. Counted by
   * `recordAuthTimeout` only — node-server does **not** also record these in
   * `authFailures[]`, so they are a separate fact rather than a subset, and a
   * surface that folds them in makes its own numbers stop adding up.
   */
  timeoutsTotal: number;
  /** Rejections by reason, highest count first. */
  byReason: { reason: string; count: number }[];
  /**
   * `failureTotal / (failureTotal + successTotal)`, or null when nothing has
   * ever presented a credential. The ratio, not the count, is the signal
   * node-server's own `authSuccessTotal` doc comment says to read: a handful
   * of failures is normal, all of them failing is config drift.
   */
  rejectRatio: number | null;
}

export function deriveHandshakeTally(node: NodeSnapshot): HandshakeTally {
  const byReason = [...node.authFailures].sort((a, b) => b.count - a.count);
  const failureTotal = byReason.reduce((sum, r) => sum + r.count, 0);
  const successTotal = node.summary.authSuccessTotal;
  const attempts = failureTotal + successTotal;
  return {
    successTotal,
    failureTotal,
    timeoutsTotal: node.summary.authTimeoutsTotal,
    byReason,
    rejectRatio: attempts === 0 ? null : failureTotal / attempts,
  };
}

/** One role's close tally on one node. */
export interface CloseGroup {
  role: ConnectionRole;
  /** Rows for this role, highest count first. */
  rows: WsCloseTally[];
  /** Closes node-server decided on. Its `reason` is authoritative. */
  serverTotal: number;
  /** Closes the far end performed. Its `reason` is remote text. */
  peerTotal: number;
  total: number;
}

/**
 * Groups one node's `wsCloses[]` by role, preserving `initiator` on every row.
 *
 * Grouping by role rather than by code is the point: the runbook question is
 * about one room's microphone uplink, and a viewer's close tally is a different
 * subject that would otherwise be summed into the same number.
 */
export function deriveCloseGroups(node: NodeSnapshot): CloseGroup[] {
  const roles: ConnectionRole[] = ['source', 'client'];
  return roles
    .map((role) => {
      const rows = node.wsCloses
        .filter((c) => c.role === role)
        .sort((a, b) => b.count - a.count);
      const serverTotal = rows
        .filter((r) => r.initiator === 'server')
        .reduce((sum, r) => sum + r.count, 0);
      const peerTotal = rows
        .filter((r) => r.initiator === 'peer')
        .reduce((sum, r) => sum + r.count, 0);
      return {
        role,
        rows,
        serverTotal,
        peerTotal,
        total: serverTotal + peerTotal,
      };
    })
    .filter((g) => g.rows.length > 0);
}

/**
 * A named diagnosis, in the PLAN §1 shape: a **cause**, an **audience** (this
 * panel's is always an operator), and a **next action**.
 *
 * Every finding is phrased to stay true of a lifetime total, because that is
 * what the underlying counters are. That constraint is why the strongest
 * verdict below keys on `successTotal === 0` — "this node has never accepted a
 * handshake" is a statement a monotonic counter can support without a window,
 * whereas "authentication is failing right now" is not. Differencing successive
 * polls to synthesise a rate was considered and deliberately not done: the poll
 * is 5 s, most windows would be all-zero, and a wrong rate presented as current
 * is precisely the class of bug this plan exists to remove.
 */
export interface NodeFinding {
  /** Stable key for React and for tests. */
  id: string;
  level: 'warning' | 'error';
  headline: string;
  cause: string;
  nextAction: string;
}

/** Fraction of rejected handshakes above which the ratio is worth naming. */
export const AUTH_REJECT_WARN_RATIO = 0.5;

/**
 * Diagnoses one node-server instance from its counters.
 *
 * Returns an empty array when nothing is worth saying — the healthy state of
 * this surface is the absence of a finding, not a green banner, for the same
 * reason the sidecar's alert list has no `info` tier.
 */
export function deriveNodeFindings(node: NodeSnapshot): NodeFinding[] {
  const findings: NodeFinding[] = [];
  const auth = deriveHandshakeTally(node);
  const invalidToken =
    auth.byReason.find((r) => r.reason === 'invalid-token')?.count ?? 0;

  if (auth.failureTotal > 0 && auth.successTotal === 0) {
    // The unambiguous case, and the one PLAN §8 question 4 asks for. A node
    // that has rejected every credential ever presented to it is not looking at
    // a handful of stale clients.
    const dominant = auth.byReason[0];
    const keyMismatch = invalidToken === auth.failureTotal;
    findings.push({
      id: `${node.nodeInstanceId}:auth-never-succeeded`,
      level: 'error',
      headline: keyMismatch
        ? `${node.nodeInstanceId} has never accepted a session token: all ${String(auth.failureTotal)} handshakes were rejected as invalid-token.`
        : `${node.nodeInstanceId} has never accepted a session token: all ${String(auth.failureTotal)} handshakes were rejected${dominant ? ` (mostly ${dominant.reason})` : ''}.`,
      cause: keyMismatch
        ? 'A token whose HMAC does not verify is the signature of a signing-key mismatch: session-manager is minting tokens with one SESSION_TOKEN_SIGNING_KEY and node-server is verifying them with another. Neither service logs this as an error — each believes it is behaving correctly.'
        : (AUTH_FAILURE_REASON_HELP[dominant?.reason ?? ''] ??
          'Every credential presented to this node has been rejected.'),
      nextAction: keyMismatch
        ? 'Compare SESSION_TOKEN_SIGNING_KEY on session-manager and on node-server; they must be byte-identical. Until they agree, no source or viewer can connect to this node and every room it owns stays silent.'
        : 'Read the per-reason breakdown below — the reason names which half of the handshake contract is being broken.',
    });
  } else if (
    auth.rejectRatio !== null &&
    auth.rejectRatio >= AUTH_REJECT_WARN_RATIO &&
    auth.failureTotal > 0
  ) {
    findings.push({
      id: `${node.nodeInstanceId}:auth-reject-ratio`,
      level: 'warning',
      headline: `${node.nodeInstanceId} has rejected ${String(Math.round(auth.rejectRatio * 100))}% of the session tokens presented to it (${String(auth.failureTotal)} rejected, ${String(auth.successTotal)} accepted since it started).`,
      cause:
        'These are totals since the process started, so this does not mean authentication is failing at this moment — but a majority-rejected node has something systematically wrong with its tokens rather than a few unlucky clients.',
      nextAction:
        'Check the per-reason breakdown below: invalid-token points at a signing-key mismatch, token-expired at clock skew or clients reusing old tokens, missing-scope at a token minted for the wrong role.',
    });
  }

  const endedRegistrations = node.summary.endedSessionRegistrationsTotal ?? 0;
  if (endedRegistrations > 0) {
    findings.push({
      id: `${node.nodeInstanceId}:ended-session-registrations`,
      level: 'warning',
      headline: `${node.nodeInstanceId} refused ${String(endedRegistrations)} source registration(s) for sessions that had already ended.`,
      cause:
        'A device connected and asked to send audio for a session past its scheduled end. It is acting on a schedule it has not been able to refresh — most often a kiosk whose mySchedule long-poll has been failing silently.',
      nextAction:
        'Check that device’s presence and its last-seen time on the device page; a kiosk in this state shows a room as scheduled while sending audio nowhere.',
    });
  }

  return findings;
}

/**
 * §4.2's counterpart on the Transcription Service side.
 *
 * `invalidProviderKeyRejects` is not a capacity refusal and not transient: the
 * registry raises it when the requested key is not in the host's configured
 * providers, so nothing about retrying or waiting will fix it. Rendering the
 * count alongside the keys the host *does* serve is what turns the number into
 * a diagnosis.
 */
export function deriveHostFindings(
  host: TranscriptionHostSnapshot,
): NodeFinding[] {
  if (host.invalidProviderKeyRejects <= 0) return [];
  const configured = Object.keys(host.providers).sort();
  return [
    {
      id: `${host.transcriptionHost}:invalid-provider-key`,
      level: 'error',
      headline: `${host.transcriptionHost} refused ${String(host.invalidProviderKeyRejects)} session(s) for a provider key it does not have configured.`,
      cause: `A session asked this host for a transcription provider it does not load. The keys it serves are: ${configured.length > 0 ? configured.join(', ') : '(none configured)'}. This is a naming disagreement, not a load problem — the session gets no captions at all, and no amount of retrying changes that.`,
      nextAction:
        'Compare the provider key configured on the room or session against the keys listed above, then fix whichever side is wrong. A room pointed at a key no host serves is silent every time it runs.',
    },
  ];
}

/** Fleet-wide counts for the panel's one polite live-region rollup. */
export interface DiagnosticsRollup {
  nodeCount: number;
  hostCount: number;
  authSuccessTotal: number;
  authFailureTotal: number;
  authTimeoutsTotal: number;
  sourceClosesTotal: number;
  clientClosesTotal: number;
  findingCount: number;
}

export function deriveDiagnosticsRollup(
  nodes: NodeSnapshot[],
  hosts: TranscriptionHostSnapshot[],
): DiagnosticsRollup {
  let authSuccessTotal = 0;
  let authFailureTotal = 0;
  let authTimeoutsTotal = 0;
  let sourceClosesTotal = 0;
  let clientClosesTotal = 0;
  let findingCount = 0;

  for (const node of nodes) {
    const auth = deriveHandshakeTally(node);
    authSuccessTotal += auth.successTotal;
    authFailureTotal += auth.failureTotal;
    authTimeoutsTotal += auth.timeoutsTotal;
    for (const close of node.wsCloses) {
      if (close.role === 'source') sourceClosesTotal += close.count;
      else clientClosesTotal += close.count;
    }
    findingCount += deriveNodeFindings(node).length;
  }
  for (const host of hosts) {
    findingCount += deriveHostFindings(host).length;
  }

  return {
    nodeCount: nodes.length,
    hostCount: hosts.length,
    authSuccessTotal,
    authFailureTotal,
    authTimeoutsTotal,
    sourceClosesTotal,
    clientClosesTotal,
    findingCount,
  };
}
