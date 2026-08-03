import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import type {
  NodeSnapshot,
  TranscriptionHostSnapshot,
} from '#src/lib/admin-api';
import { browserTimeZone, formatInTimeZone } from '#src/lib/timezone';

import type { NodeFinding } from './node-diagnostics';
import {
  AUTH_FAILURE_REASON_HELP,
  CLOSE_INITIATOR_LABEL,
  CONNECTION_ROLE_LABEL,
  deriveCloseGroups,
  deriveDiagnosticsRollup,
  deriveHandshakeTally,
  deriveHostFindings,
  deriveNodeFindings,
} from './node-diagnostics';

/**
 * Sentence appended wherever a counter is shown, because every counter on this
 * panel is a lifetime total since the publishing process started and reading
 * one as "what is happening now" is the exact mistake this whole plan is about.
 */
const EPOCH_NOTE =
  'All counts are totals since the process started, not rates. A restart returns them to zero.';

const PEER_REASON_NOTE =
  'A close the far end performed carries remote-supplied text, which node-server normalises to “other” unless it matches a reason it knows — so “other” on a far-end row means “unlabelled”, not a specific fault. A close node-server performed carries a reason it chose, and that one is authoritative.';

/** One finding, rendered as cause → next action. Colour is never the only cue:
 *  the severity word is in the `AlertTitle`'s own icon and the text states the
 *  problem outright, matching `AlertsPanel`'s card. */
const FindingAlert = ({ finding }: { finding: NodeFinding }) => (
  <Alert severity={finding.level} sx={{ mb: 1 }}>
    <AlertTitle>{finding.headline}</AlertTitle>
    <Typography variant="body2" sx={{ mb: 0.5 }}>
      {finding.cause}
    </Typography>
    <Typography variant="body2">
      <Box component="strong">Next: </Box>
      {finding.nextAction}
    </Typography>
  </Alert>
);

/**
 * Handshake outcomes for one node (PLAN-VisibleErrors §4.1, runbook question
 * 4).
 *
 * Accepted, rejected and timed-out are three separate figures rather than a
 * pass/fail pair because node-server counts them separately and they mean
 * different things: a rejection is a credential this node looked at and
 * refused, a timeout is a socket that never presented one at all. The
 * per-reason rows name the failure instead of totalling it — "3 auth failures"
 * cannot be acted on, "3 invalid-token" can.
 */
const HandshakeSection = ({ node }: { node: NodeSnapshot }) => {
  const auth = deriveHandshakeTally(node);

  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" component="h4">
        Session-token handshakes
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Chip
          size="small"
          variant="outlined"
          label={`accepted: ${String(auth.successTotal)}`}
          color={auth.successTotal > 0 ? 'success' : 'default'}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`rejected: ${String(auth.failureTotal)}`}
          color={auth.failureTotal > 0 ? 'warning' : 'default'}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`never authenticated: ${String(auth.timeoutsTotal)}`}
          color={auth.timeoutsTotal > 0 ? 'warning' : 'default'}
        />
      </Stack>
      {auth.byReason.length === 0 ? (
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}
        >
          {auth.successTotal === 0 && auth.timeoutsTotal === 0
            ? 'No connection has ever presented a session token to this node — nothing has tried to connect, as distinct from trying and being refused.'
            : 'No credential has been rejected by this node.'}
        </Typography>
      ) : (
        <TableContainer sx={{ mt: 0.5 }}>
          <Table
            size="small"
            aria-label={`Rejected handshakes on ${node.nodeInstanceId}`}
          >
            <TableHead>
              <TableRow>
                <TableCell>Reason</TableCell>
                <TableCell align="right">Count</TableCell>
                <TableCell>What it means</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {auth.byReason.map((row) => (
                <TableRow key={row.reason}>
                  <TableCell sx={{ fontFamily: 'monospace' }}>
                    {row.reason}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {row.count}
                  </TableCell>
                  <TableCell>
                    {/* An unrecognised reason is shown with no gloss rather
                        than a guess: `authFailures[].reason` is an open set and
                        a newer node-server may name one this console predates. */}
                    {AUTH_FAILURE_REASON_HELP[row.reason] ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Typography
        variant="caption"
        sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}
      >
        “Never authenticated” counts sockets that opened and never sent a token
        inside the watchdog window; node-server records those separately, so
        they are not part of the rejected total above.
      </Typography>
    </Box>
  );
};

/**
 * Socket closes for one node, grouped by role and always labelled with
 * `initiator` (PLAN-VisibleErrors §4.1, runbook question 3).
 *
 * The grouping is what makes "the source keeps dropping" separable from "the
 * source never connected": a role with no rows at all has never had a socket
 * close, and a role whose rows are overwhelmingly far-end closes is flapping.
 * Both readings are impossible from an undifferentiated code tally, which is
 * what this data looked like before anything rendered it.
 */
const CloseSection = ({ node }: { node: NodeSnapshot }) => {
  const groups = deriveCloseGroups(node);

  if (groups.length === 0) {
    return (
      <Box sx={{ mt: 1.5 }}>
        <Typography variant="subtitle2" component="h4">
          Socket closes
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          No transcription-stream socket has closed on this node since it
          started — neither a source nor a viewer has connected and gone away.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" component="h4">
        Socket closes
      </Typography>
      {groups.map((group) => (
        <Box key={group.role} sx={{ mt: 1 }}>
          <Typography variant="body2">
            {CONNECTION_ROLE_LABEL[group.role]} — {group.total} close
            {group.total === 1 ? '' : 's'}: {group.peerTotal} by the far end,{' '}
            {group.serverTotal} by node-server.
          </Typography>
          <TableContainer sx={{ mt: 0.5 }}>
            <Table
              size="small"
              aria-label={`${CONNECTION_ROLE_LABEL[group.role]} closes on ${node.nodeInstanceId}`}
            >
              <TableHead>
                <TableRow>
                  <TableCell>Code</TableCell>
                  <TableCell>Reason</TableCell>
                  <TableCell>Who closed it</TableCell>
                  <TableCell align="right">Count</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {group.rows.map((row) => (
                  <TableRow
                    key={`${String(row.code)}:${row.reason}:${row.initiator}`}
                  >
                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {row.code}
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>
                      {row.reason === '' ? '(none)' : row.reason}
                    </TableCell>
                    <TableCell>
                      {CLOSE_INITIATOR_LABEL[row.initiator]}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {row.count}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ))}
      <Typography
        variant="caption"
        sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}
      >
        {PEER_REASON_NOTE}
      </Typography>
    </Box>
  );
};

/** Frame-level drops and uplink churn — the counters that explain a session
 *  whose source is connected while nothing reaches the ASR. */
const ThroughputSection = ({ node }: { node: NodeSnapshot }) => {
  const { summary } = node;
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" component="h4">
        Dropped frames and uplink churn
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Chip
          size="small"
          variant="outlined"
          label={`malformed frames dropped: ${String(summary.decodeDropsTotal)}`}
          color={summary.decodeDropsTotal > 0 ? 'warning' : 'default'}
        />
        <Chip
          size="small"
          variant="outlined"
          // `undefined` means this publisher does not report the field at all
          // (it is optional on the wire for rolling-deploy safety), which is a
          // different fact from zero and must not be rendered as one.
          label={
            summary.binaryBeforeAuthDropsTotal === undefined
              ? 'pre-auth audio dropped: not reported'
              : `pre-auth audio dropped: ${String(summary.binaryBeforeAuthDropsTotal)}`
          }
          color={
            (summary.binaryBeforeAuthDropsTotal ?? 0) > 0
              ? 'warning'
              : 'default'
          }
        />
        <Chip
          size="small"
          variant="outlined"
          label={`ASR uplink reconnects: ${String(summary.upstreamChurnTotal)}`}
          color={summary.upstreamChurnTotal > 0 ? 'warning' : 'default'}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`orchestrator failures: ${String(summary.orchestratorFailuresTotal)}`}
          color={summary.orchestratorFailuresTotal > 0 ? 'error' : 'default'}
        />
      </Stack>
    </Box>
  );
};

const NodeCard = ({ node }: { node: NodeSnapshot }) => {
  const zone = browserTimeZone();
  return (
    <Card variant="outlined" sx={{ mb: 1 }}>
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Typography
            variant="subtitle1"
            component="h3"
            sx={{ fontFamily: 'monospace' }}
          >
            {node.nodeInstanceId}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={`${String(node.summary.activeSessionCount)} active session${node.summary.activeSessionCount === 1 ? '' : 's'}`}
          />
          <Chip
            size="small"
            variant="outlined"
            label={`counting since ${formatInTimeZone(node.processStartedAt, zone)}`}
          />
        </Stack>
        <HandshakeSection node={node} />
        <CloseSection node={node} />
        <ThroughputSection node={node} />
      </CardContent>
    </Card>
  );
};

/**
 * Transcription Service host inventory (PLAN-VisibleErrors §4.2).
 *
 * The provider keys column is the reason this table exists rather than a bare
 * `invalidProviderKeyRejects` number: the rejection only becomes actionable
 * next to the list of keys the host would have accepted.
 */
const HostTable = ({ hosts }: { hosts: TranscriptionHostSnapshot[] }) => {
  const zone = browserTimeZone();
  return (
    <TableContainer sx={{ mt: 1 }}>
      <Table size="small" aria-label="Transcription Service hosts">
        <TableHead>
          <TableRow>
            <TableCell>Host</TableCell>
            <TableCell align="right">Workers</TableCell>
            <TableCell>Provider keys served</TableCell>
            <TableCell align="right">Unknown-key refusals</TableCell>
            <TableCell>Counting since</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {hosts.map((host) => {
            const keys = Object.keys(host.providers).sort();
            return (
              <TableRow key={host.transcriptionHost}>
                <TableCell sx={{ fontFamily: 'monospace' }}>
                  {host.transcriptionHost}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {host.numWorkers}
                </TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>
                  {keys.length > 0 ? keys.join(', ') : 'none configured'}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{
                    fontVariantNumeric: 'tabular-nums',
                    color:
                      host.invalidProviderKeyRejects > 0
                        ? 'error.main'
                        : 'text.primary',
                  }}
                >
                  {host.invalidProviderKeyRejects}
                </TableCell>
                <TableCell>
                  {formatInTimeZone(host.processStartedAt, zone)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
};

export interface NodeDiagnosticsPanelProps {
  nodes: NodeSnapshot[];
  hosts: TranscriptionHostSnapshot[];
}

/**
 * Renders the node-server and Transcription Service counters that
 * `FleetSnapshot` has been carrying to the browser every 5 seconds and that
 * nothing read (PLAN-VisibleErrors §4.1, §4.2). It answers two runbook
 * questions the console could not previously answer at all: "is the source
 * dropping or did it never connect" and "is this a signing-key mismatch".
 *
 * Shape follows what an operator does with it. Findings — the named diagnoses —
 * sit outside the accordion and are always visible, because a collapsed
 * section is a section nobody opens during an incident. The tables behind them
 * are collapsed by default: they are the evidence for a finding, not a thing to
 * scan, and a permanently-expanded wall of counters is its own kind of
 * unreadable.
 *
 * **Live-region discipline** (LESSONSLEARNED, "a polled list must not be a live
 * region"): this whole panel re-renders on the fleet panel's 5 s poll, so the
 * tables sit outside any live region and only the counts rollup is
 * `aria-live="polite"`. Because the underlying counters are monotonic and only
 * move when something actually happens, that rollup announces exactly when
 * there is news — which is the behaviour a live region is for.
 */
export const NodeDiagnosticsPanel = ({
  nodes,
  hosts,
}: NodeDiagnosticsPanelProps) => {
  if (nodes.length === 0 && hosts.length === 0) return null;

  const findings = [
    ...nodes.flatMap((node) => deriveNodeFindings(node)),
    ...hosts.flatMap((host) => deriveHostFindings(host)),
  ];
  const rollup = deriveDiagnosticsRollup(nodes, hosts);

  return (
    <Box sx={{ mb: 2 }}>
      {findings.map((finding) => (
        <FindingAlert key={finding.id} finding={finding} />
      ))}
      {/*
        Outside the Accordion, not inside its summary: ARIA treats the content
        of a button as presentational, so a live region nested in an
        `AccordionSummary` would never announce — the same trap `SessionCard`'s
        audio strip documents for `role="progressbar"` inside a
        `CardActionArea`. Keeping it a sibling also means the headline counts
        stay readable while the detail is collapsed.
      */}
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: 'wrap', mb: 1 }}
        aria-live="polite"
        aria-label="Connection diagnostics summary"
      >
        <Chip
          size="small"
          variant="outlined"
          label={`${String(rollup.nodeCount)} node-server, ${String(rollup.hostCount)} transcription host${rollup.hostCount === 1 ? '' : 's'}`}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`handshakes ${String(rollup.authSuccessTotal)} accepted / ${String(rollup.authFailureTotal)} rejected`}
          color={
            rollup.authFailureTotal > 0 && rollup.authSuccessTotal === 0
              ? 'error'
              : rollup.authFailureTotal > 0
                ? 'warning'
                : 'default'
          }
        />
        <Chip
          size="small"
          variant="outlined"
          label={`source closes ${String(rollup.sourceClosesTotal)} · viewer closes ${String(rollup.clientClosesTotal)}`}
        />
      </Stack>
      <Accordion variant="outlined" disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          {/*
            `component="span"`, not the `h6` MUI's `subtitle2` variant mapping
            would otherwise emit: this label lives inside the accordion's
            button, where a heading is both wrong semantically and — because
            the panel sits under the fleet panel's `h2` — a three-level jump
            that axe flags. Caught by the a11y test, not by eye.
          */}
          <Typography variant="subtitle2" component="span">
            Connection diagnostics — node-server handshakes, socket closes and
            transcription hosts
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', display: 'block', mb: 1 }}
          >
            {EPOCH_NOTE}
          </Typography>
          {nodes.map((node) => (
            <NodeCard key={node.processUid} node={node} />
          ))}
          {hosts.length > 0 && (
            <>
              <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
                Transcription Service hosts
              </Typography>
              <HostTable hosts={hosts} />
            </>
          )}
        </AccordionDetails>
      </Accordion>
    </Box>
  );
};
