import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';

import { FleetPanel } from '#src/features/dashboard/fleet-panel';
import { useFleet } from '#src/features/dashboard/use-fleet';
import type {
  FleetSnapshot,
  SessionAudioSnapshot,
  SessionSnapshot,
} from '#src/lib/admin-api';

import { renderWithProviders } from '../../utils/render-with-providers';

vi.mock('#src/features/dashboard/use-fleet', () => ({
  useFleet: vi.fn(),
}));

vi.mock('#src/lib/admin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/lib/admin-api')>();
  return {
    ...actual,
    adminApi: { getSessionJoinCode: vi.fn() },
  };
});

function buildSession(
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    sessionUid: 'session-1',
    roomUid: null,
    providerKey: 'whisper',
    sourceCount: 1,
    subscriberCount: 1,
    pendingChunkCount: 0,
    upstreamState: 'OPEN',
    upstreamRetryAttempt: 0,
    latency: [],
    updatedAt: 1_000,
    nodeInstanceId: 'node-a',
    processUid: 'proc-1',
    ...overrides,
  };
}

function buildAudio(
  overrides: Partial<SessionAudioSnapshot> = {},
): SessionAudioSnapshot {
  return {
    rmsDbfs: -23.4,
    peakDbfs: -12.1,
    clippingPct: 0,
    silence: false,
    noiseFloorDbfs: -65.0,
    updatedAt: 1_000,
    vadStats: null,
    sessionUid: 'session-1',
    roomUid: null,
    transcriptionHost: 'ts-a',
    ...overrides,
  };
}

function mountFleet(
  sessions: SessionSnapshot[],
  sessionAudio: SessionAudioSnapshot[],
): void {
  const snapshot: FleetSnapshot = {
    generatedAt: 1,
    nodes: [],
    sessions,
    transcriptionHosts: [],
    providers: [],
    sessionAudio,
  };
  vi.mocked(useFleet).mockReturnValue({
    snapshot,
    sessionEvents: new Map(),
    connected: true,
    available: true,
    refresh: vi.fn(),
  });
  renderWithProviders(<FleetPanel />);
}

/**
 * The grid's default filter is `status: ['crit','warn']`, so a card only renders
 * for a session whose *connectivity* status is one of those. `CONNECTING` derives
 * as `warn` — the cheapest way to get a card on screen without reaching into the
 * panel's filter state, and orthogonal to the audio axis under test (D1).
 */
const visibleSession = (overrides: Partial<SessionSnapshot> = {}) =>
  buildSession({ upstreamState: 'CONNECTING', ...overrides });

describe('FleetPanel audio roll-up', (it) => {
  beforeEach(() => {
    vi.mocked(useFleet).mockReset();
  });

  it('shows the "metering unavailable" state when no session has audio, even though every live session derives as crit', () => {
    // The trap this pins down: deriveAudioStatus maps "no snapshot + OPEN" to
    // crit (C1), so a roll-up keyed on the derived counts could never fire in
    // the one environment the state exists for — live sessions, no publisher.
    mountFleet([buildSession({ upstreamState: 'OPEN' })], []);

    expect(
      screen.getByText(/Pipeline audio metering unavailable/),
    ).toBeInTheDocument();
  });

  it('keeps the roll-up counts visible alongside the unavailable notice', () => {
    // The operator still needs the counts; they just need to know the crits
    // mean "nothing is publishing", not "every mic died at once".
    mountFleet([buildSession({ upstreamState: 'OPEN' })], []);

    expect(screen.getByLabelText('Fleet audio summary')).toBeInTheDocument();
  });

  it('does not show the unavailable notice once any session has audio', () => {
    mountFleet(
      [buildSession({ sessionUid: 'session-1' })],
      [buildAudio({ sessionUid: 'session-1' })],
    );

    expect(
      screen.queryByText(/Pipeline audio metering unavailable/),
    ).not.toBeInTheDocument();
  });

  it('labels the audio conventions without leaking escape sequences', () => {
    // The tooltip text used to be written as a JSX string attribute, where
    // − is not an escape — it rendered verbatim.
    mountFleet(
      [buildSession({ sessionUid: 'session-1' })],
      [buildAudio({ sessionUid: 'session-1' })],
    );

    const conventions = screen.getByLabelText('Audio conventions');

    expect(conventions).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('\\u');
  });
});

describe('SessionCard audio strip', (it) => {
  beforeEach(() => {
    vi.mocked(useFleet).mockReset();
  });

  it('renders clippingPct as a percentage, not as the raw fraction', () => {
    // clippingPct is a fraction: 0.05 is 5% of samples clipped, not 0.05%.
    mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [buildAudio({ sessionUid: 'session-1', clippingPct: 0.05 })],
    );

    expect(screen.getByText('clipping 5.00%')).toBeInTheDocument();
    expect(screen.queryByText('clipping 0.05%')).not.toBeInTheDocument();
  });

  it('never renders a clipping chip that claims 0.00%', () => {
    // The chip only appears because clippingPct > 0, so "0.00%" would
    // contradict its own reason for being on screen.
    mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [buildAudio({ sessionUid: 'session-1', clippingPct: 0.000005 })],
    );

    expect(screen.getByText('clipping <0.01%')).toBeInTheDocument();
  });
});
