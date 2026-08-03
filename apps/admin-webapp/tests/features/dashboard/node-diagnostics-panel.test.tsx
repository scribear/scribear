import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect } from 'vitest';

import { NodeDiagnosticsPanel } from '#src/features/dashboard/node-diagnostics-panel';
import type {
  NodeSnapshot,
  TranscriptionHostSnapshot,
} from '#src/lib/admin-api';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildHost, buildNode } from './node-fixtures';

function mount(
  nodes: NodeSnapshot[],
  hosts: TranscriptionHostSnapshot[] = [],
): HTMLElement {
  return renderWithProviders(
    <NodeDiagnosticsPanel nodes={nodes} hosts={hosts} />,
  ).container;
}

/** The detail tables live behind a collapsed accordion by default. */
async function expandDetail(): Promise<void> {
  await userEvent.click(
    screen.getByRole('button', { name: /connection diagnostics/i }),
  );
}

describe('NodeDiagnosticsPanel', (it) => {
  it('renders nothing when the snapshot carries no nodes or hosts', () => {
    const container = mount([], []);

    expect(container).toBeEmptyDOMElement();
  });

  it('names a signing-key mismatch without needing the detail opened', async () => {
    // PLAN §8 question 4. A finding an operator has to expand an accordion to
    // discover is a finding nobody sees during an incident.
    mount([
      buildNode({
        summary: { ...buildNode().summary, authSuccessTotal: 0 },
        authFailures: [{ reason: 'invalid-token', count: 47 }],
      }),
    ]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/never accepted a session token/i);
    expect(alert).toHaveTextContent(/signing-key mismatch/i);
    expect(alert).toHaveTextContent(/SESSION_TOKEN_SIGNING_KEY/);
  });

  it('raises no finding for a healthy node', () => {
    mount([buildNode()]);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves initiator as words on every close row', async () => {
    // `initiator` is the whole reason the tally is labelled: a flapping source
    // uplink must not read as an auth failure.
    mount([
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
        ],
      }),
    ]);
    await expandDetail();

    expect(screen.getByText('the far end closed it')).toBeInTheDocument();
    expect(screen.getByText('node-server closed it')).toBeInTheDocument();
    // And the split is stated in prose too, so the pattern is legible without
    // reading every row.
    expect(
      screen.getByText(/41 by the far end, 2 by node-server/i),
    ).toBeInTheDocument();
  });

  it('distinguishes "nothing ever connected" from "it keeps dropping"', async () => {
    // Runbook question 3, the half that a close tally alone cannot express:
    // an absent label combination means it never happened.
    mount([
      buildNode({
        summary: { ...buildNode().summary, authSuccessTotal: 0 },
      }),
    ]);
    await expandDetail();

    expect(
      screen.getByText(/no transcription-stream socket has closed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/has ever presented a session token to this node/i),
    ).toBeInTheDocument();
  });

  it('breaks rejections out by reason and explains each one', async () => {
    mount([
      buildNode({
        authFailures: [
          { reason: 'invalid-token', count: 3 },
          { reason: 'missing-scope', count: 1 },
        ],
      }),
    ]);
    await expandDetail();

    expect(screen.getByText('invalid-token')).toBeInTheDocument();
    expect(screen.getByText('missing-scope')).toBeInTheDocument();
    expect(screen.getByText(/HMAC did not verify/i)).toBeInTheDocument();
    expect(screen.getByText(/SEND_AUDIO for a source/i)).toBeInTheDocument();
  });

  it('renders an unrecognised reason verbatim rather than guessing at it', async () => {
    // `authFailures[].reason` is an open set — a newer node-server may name a
    // reason this console predates.
    mount([
      buildNode({ authFailures: [{ reason: 'brand-new-reason', count: 2 }] }),
    ]);
    await expandDetail();

    expect(screen.getByText('brand-new-reason')).toBeInTheDocument();
  });

  it('keeps auth timeouts visible as their own figure, not folded into rejections', async () => {
    mount([
      buildNode({
        summary: { ...buildNode().summary, authTimeoutsTotal: 5 },
      }),
    ]);
    await expandDetail();

    expect(screen.getByText('never authenticated: 5')).toBeInTheDocument();
    expect(screen.getByText('rejected: 0')).toBeInTheDocument();
  });

  it('says "not reported" for an optional counter an older publisher omits', async () => {
    mount([buildNode()]);
    await expandDetail();

    // Not "0": the publisher not carrying the field is a different fact from
    // it having counted nothing.
    expect(
      screen.getByText('pre-auth audio dropped: not reported'),
    ).toBeInTheDocument();
  });

  it('names the provider keys a host serves beside its unknown-key refusals', async () => {
    mount([], [buildHost({ invalidProviderKeyRejects: 3 })]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/refused 3 session\(s\)/i);
    expect(alert).toHaveTextContent(/whisper/);

    await expandDetail();
    expect(screen.getByText('ts-1')).toBeInTheDocument();
  });

  it('puts only the counts rollup in a live region, never the polled tables', async () => {
    // LESSONSLEARNED: "a polled list must not be a live region" — this panel
    // re-renders on the fleet panel's 5 s poll.
    const container = mount([
      buildNode({
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
    ]);
    await expandDetail();

    const rollup = screen.getByLabelText('Connection diagnostics summary');
    expect(rollup).toHaveAttribute('aria-live', 'polite');
    expect(rollup).toHaveTextContent('handshakes 10 accepted / 0 rejected');
    expect(rollup).toHaveTextContent('source closes 4');

    for (const table of container.querySelectorAll('table')) {
      expect(rollup.contains(table)).toBe(false);
    }
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('states the counting epoch, so a lifetime total is not read as "now"', async () => {
    mount([buildNode()]);
    await expandDetail();

    expect(
      screen.getByText(/totals since the process started/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/counting since/i)).toBeInTheDocument();
  });

  it('has no a11y violations with findings and the detail expanded', async () => {
    // Rendered under stand-in page headings: in the app this panel sits inside
    // `FleetPanel`, whose "Live fleet" is an `h2`, and its own `h3`/`h4`
    // sections are numbered against that. Mounted bare, the first heading
    // would be an `h3` with nothing above it and axe would flag the jump —
    // a defect of the harness, not of the component.
    const { container } = renderWithProviders(
      <>
        <h1>Dashboard</h1>
        <h2>Live fleet</h2>
        <NodeDiagnosticsPanel
          nodes={[
            buildNode({
              summary: { ...buildNode().summary, authSuccessTotal: 0 },
              authFailures: [{ reason: 'invalid-token', count: 47 }],
              wsCloses: [
                {
                  code: 1006,
                  reason: '',
                  role: 'source',
                  initiator: 'peer',
                  count: 41,
                },
                {
                  code: 1001,
                  reason: '',
                  role: 'client',
                  initiator: 'peer',
                  count: 2,
                },
              ],
            }),
          ]}
          hosts={[buildHost({ invalidProviderKeyRejects: 1 })]}
        />
      </>,
    );
    await expandDetail();

    const results = await axe(container);

    expect(results.violations).toHaveLength(0);
  });
});
