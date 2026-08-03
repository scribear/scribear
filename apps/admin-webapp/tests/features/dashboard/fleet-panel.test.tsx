import { screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { beforeEach, describe, expect, vi } from 'vitest';

import { FleetPanel } from '#src/features/dashboard/fleet-panel';
import { FLEET_STALE_AFTER_MS } from '#src/features/dashboard/telemetry-freshness';
import type { FleetState } from '#src/features/dashboard/use-fleet';
import { useFleet } from '#src/features/dashboard/use-fleet';
import type {
  AudioLevelStats,
  FleetSnapshot,
  MergedProvider,
  ProviderHealth,
  SessionAudioSnapshot,
  SessionSnapshot,
  SessionStatusEvent,
  TranscriptionWorker,
} from '#src/lib/admin-api';

import { renderWithProviders } from '../../utils/render-with-providers';
import {
  buildAudioSnapshot,
  buildLevels,
  buildThroughputOnlySnapshot,
  buildVadStats,
  stageIngress,
  stageVad,
} from './audio-fixtures';

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

/**
 * A published snapshot for one session, metered at ingress only — the graph
 * every provider now reports (§12.3), minus the stages a case does not need.
 * `levels` overrides land on the **headline** stage, since that is the one every
 * card surface reads (§12.6).
 */
function buildAudio(
  levels: Partial<AudioLevelStats> = {},
  overrides: Partial<SessionAudioSnapshot> = {},
): SessionAudioSnapshot {
  return buildAudioSnapshot({
    stages: [stageIngress({ levels: buildLevels(levels) })],
    ...overrides,
  });
}

function mountFleet(
  sessions: SessionSnapshot[],
  sessionAudio: SessionAudioSnapshot[],
  sessionEvents = new Map<string, SessionStatusEvent>(),
  providers: MergedProvider[] = [],
): HTMLElement {
  const snapshot: FleetSnapshot = {
    generatedAt: 1,
    nodes: [],
    sessions,
    transcriptionHosts: [],
    providers,
    sessionAudio,
  };
  vi.mocked(useFleet).mockReturnValue({
    snapshot,
    sessionEvents,
    connected: true,
    available: true,
    poll: { status: 'ok', lastSuccessAt: Date.now() },
    refresh: vi.fn(),
  });
  return renderWithProviders(<FleetPanel />).container;
}

function buildWorker(
  overrides: Partial<TranscriptionWorker> = {},
): TranscriptionWorker {
  return {
    workerId: 0,
    utilization: 0.5,
    liveJobCount: 0,
    totalJobsRegistered: 0,
    contextIds: [],
    alive: true,
    activeJobs: [],
    estimatedCapacitySessions: null,
    ...overrides,
  };
}

function buildProviderHealth(
  overrides: Partial<ProviderHealth> = {},
): ProviderHealth {
  return {
    providerUid: 'whisper-streaming',
    kind: 'local',
    status: 'ok',
    activeSessions: 0,
    sessionsRefusedCapacityTotal: 0,
    model: null,
    modelLoaded: null,
    owningWorkers: [],
    endpoint: null,
    reachable: null,
    probeLatencyMs: null,
    detail: null,
    ...overrides,
  };
}

function buildMergedProvider(
  overrides: Partial<MergedProvider> = {},
): MergedProvider {
  return {
    providerKey: 'whisper',
    status: 'ok',
    activeSessions: 0,
    sessionsRefusedCapacityTotal: 0,
    hosts: [{ transcriptionHost: 'gpu-1', health: buildProviderHealth() }],
    ...overrides,
  };
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
      [buildAudio({}, { sessionUid: 'session-1' })],
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
      [buildAudio({}, { sessionUid: 'session-1' })],
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
      [buildAudio({ clippingPct: 0.05 }, { sessionUid: 'session-1' })],
    );

    expect(screen.getByText('clipping 5.00%')).toBeInTheDocument();
    expect(screen.queryByText('clipping 0.05%')).not.toBeInTheDocument();
  });

  it('never renders a clipping chip that claims 0.00%', () => {
    // The chip only appears because clippingPct > 0, so "0.00%" would
    // contradict its own reason for being on screen.
    mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [buildAudio({ clippingPct: 0.000005 }, { sessionUid: 'session-1' })],
    );

    expect(screen.getByText('clipping <0.01%')).toBeInTheDocument();
  });

  it('reads the level from the headline stage, not from a deeper one', () => {
    // §12.6: the strip must show the measurement closest to the source, the same
    // one the chip beside it classified. Two stages with different levels is the
    // only way to tell which one reached the screen.
    mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [
        buildAudioSnapshot({
          sessionUid: 'session-1',
          stages: [
            stageIngress({ levels: buildLevels({ rmsDbfs: -23.4 }) }),
            {
              stage: 'asr_input',
              label: 'ASR input (worker decode)',
              depth: 2,
              inputs: ['ingress'],
              levels: buildLevels({ rmsDbfs: -41.2 }),
              vad: null,
              audioSeconds: 100,
            },
          ],
        }),
      ],
    );

    expect(screen.getByText('-23.4 dBFS')).toBeInTheDocument();
    expect(screen.queryByText('-41.2 dBFS')).not.toBeInTheDocument();
  });

  it('renders the speech chip from whichever stage carries the detector', () => {
    // The detector is a different measurement point from the headline stage, so
    // a card that only looked at the headline would silently lose the VAD chip.
    mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [
        buildAudioSnapshot({
          sessionUid: 'session-1',
          stages: [
            stageIngress(),
            stageVad({ vad: buildVadStats({ speechActiveRatio: 0.12 }) }),
          ],
        }),
      ],
    );

    expect(screen.getByText('speech 12%')).toBeInTheDocument();
  });
});

describe('SessionCard layout', (it) => {
  beforeEach(() => {
    vi.mocked(useFleet).mockReset();
  });

  it('stays a full-width column through the whole `sm` range, not two-up', () => {
    // AppLayout's sidebar is a fixed ~232px at every viewport width, so a
    // `sm: 6` card (the old value) got ~150px at a 600px viewport — too
    // narrow for the audio strip (bar + dBFS readout) to fit without
    // clipping, measured in a real browser. jsdom does no layout, so this
    // can't see the resulting pixel widths; it only pins the breakpoint prop
    // Grid actually receives, as a proxy for "don't go back to two columns
    // before the sidebar's fixed cost stops mattering".
    const container = mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [buildAudio({}, { sessionUid: 'session-1' })],
    );

    const sessionGrid = [...container.querySelectorAll('.MuiGrid-root')].find(
      (el) => el.className.includes('MuiGrid-grid-xs-12'),
    );

    expect(sessionGrid?.className).toContain('MuiGrid-grid-sm-12');
    expect(sessionGrid?.className).not.toContain('MuiGrid-grid-sm-6');
  });

  it('lets the header row wrap the status/audio chips below the session UID', () => {
    // A full UUID and the two rigid (flexShrink: 0) chips are both fixed-size
    // content competing for one line; on a card too narrow for both, the only
    // place flexbox could take space from used to be the UID itself — down
    // past its longest unbreakable hyphen segment, which overflowed the card
    // (measured in a real browser: the audio chip's tail landed under the
    // neighbouring grid cell). `flexWrap: 'wrap'` lets the chip group drop to
    // its own line instead. jsdom does no layout, so it can't see the
    // overflow or the wrap actually happen — this only asserts the
    // declaration is present.
    const container = mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [buildAudio({}, { sessionUid: 'session-1' })],
    );

    const header = container.querySelector(
      '.MuiCardContent-root .MuiStack-root',
    );

    expect(header).not.toBeNull();
    expect(getComputedStyle(header!).flexWrap).toBe('wrap');
  });

  it('wraps the session UID at natural break points instead of one character per line', () => {
    // `word-break: break-all` allows a break between *any* two characters,
    // which the browser's min-content calculation takes literally: the
    // flex item's floor becomes one glyph wide, so — squeezed against the
    // fixed-size chips — the UID rendered one character per line (measured in
    // a real browser). `overflow-wrap: break-word` only breaks a run that
    // truly doesn't fit, and unlike `break-all` it doesn't enter the
    // min-content calculation, so it doesn't pre-emptively shrink. This only
    // pins the declaration change; jsdom can't see how a UUID actually wraps.
    mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [buildAudio({}, { sessionUid: 'session-1' })],
    );

    const uid = screen.getByText('session-1');

    expect(getComputedStyle(uid).overflowWrap).toBe('break-word');
    expect(getComputedStyle(uid).wordBreak).not.toBe('break-all');
  });
});

describe('SessionCard with a throughput-only snapshot', (it) => {
  beforeEach(() => {
    vi.mocked(useFleet).mockReset();
  });

  it('says metering is unavailable rather than showing a bar at rest', () => {
    // §12.8 point 1. A snapshot exists and no stage meters (the `debug`
    // provider's shape), so there is no dBFS to draw. An empty strip reads as
    // "nothing to report" and a bar at rest reads as silence; both are the false
    // green this state exists to avoid. The seconds count is the honest signal
    // available: audio is demonstrably flowing.
    mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [buildThroughputOnlySnapshot({ sessionUid: 'session-1' })],
    );

    expect(
      screen.getByText(/metering unavailable for this provider/),
    ).toBeInTheDocument();
    expect(screen.getByText(/33\.6 s of audio counted/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows the audio chip as unknown, not good and not crit', () => {
    // The two false answers, both of which shipped at some point: `crit` was the
    // §12.1 bug (a red chip on every healthy debug/lumen_granite session), and
    // `good` would be the same bug inverted — a green chip asserted from zero
    // level measurements.
    mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [buildThroughputOnlySnapshot({ sessionUid: 'session-1' })],
    );

    expect(screen.getByText('audio: unknown')).toBeInTheDocument();
    expect(screen.queryByText('audio: good')).not.toBeInTheDocument();
    expect(screen.queryByText('audio: crit')).not.toBeInTheDocument();
  });
});

describe('SessionCard with no audio snapshot', (it) => {
  beforeEach(() => {
    vi.mocked(useFleet).mockReset();
  });

  it('names the source as the suspect for an OPEN session with no frames received', () => {
    // PLAN-AUDIOVIZ §7.2: when there is no snapshot for an OPEN session the
    // strip must render the finding, not disappear — the absence *is* failure
    // mode C1. An empty space reads as "nothing to report".
    //
    // `audioFramesReceived: 0` splits that finding one level further: the
    // upstream is open and node-server has received nothing, so the source is
    // the thing to go and look at.
    //
    // The session event is only here to get the card past the grid's default
    // `['crit','warn']` connectivity filter; an OPEN session with a healthy
    // stream derives `good` and would be filtered out.
    const session = buildSession({
      upstreamState: 'OPEN',
      audioFramesReceived: 0,
    });
    const events = new Map<string, SessionStatusEvent>([
      [
        session.sessionUid,
        {
          t: 'session',
          sessionUid: session.sessionUid,
          transcriptionServiceConnected: false,
          sourceDeviceConnected: true,
          at: 1_000,
        },
      ],
    ]);

    mountFleet([session], [], events);

    expect(screen.getByText('no audio from source')).toBeInTheDocument();
  });

  it('blames the pipeline, not the source, once frames have been received', () => {
    // The other half of the split. Same visible state - upstream OPEN, no audio
    // snapshot - but node-server has counted frames from the source, so the
    // microphone is provably fine and the break is downstream. Telling these
    // two apart is the whole point of the counter: without it both read as "no
    // audio reaching ASR" and every investigation starts by checking the mic.
    const session = buildSession({
      upstreamState: 'OPEN',
      audioFramesReceived: 1200,
    });
    const events = new Map<string, SessionStatusEvent>([
      [
        session.sessionUid,
        {
          t: 'session',
          sessionUid: session.sessionUid,
          transcriptionServiceConnected: false,
          sourceDeviceConnected: true,
          at: 1_000,
        },
      ],
    ]);

    mountFleet([session], [], events);

    expect(
      screen.getByText('audio received, not reaching ASR'),
    ).toBeInTheDocument();
    expect(screen.queryByText('no audio from source')).not.toBeInTheDocument();
  });

  it('renders the softer "no audio telemetry" when the session is not OPEN', () => {
    // Not a finding: nothing is expected to be decoding audio for a session
    // whose upstream is still connecting, so the copy must not accuse a mic.
    mountFleet([visibleSession({ upstreamState: 'CONNECTING' })], []);

    expect(screen.getByText('no audio telemetry')).toBeInTheDocument();
    expect(screen.queryByText('no audio from source')).not.toBeInTheDocument();
  });
});

describe('FleetPanel provider capacity', (it) => {
  beforeEach(() => {
    vi.mocked(useFleet).mockReset();
  });

  it('renders a live/estimated readout for a local provider', () => {
    const provider = buildMergedProvider({
      providerKey: 'whisper',
      activeSessions: 2,
      hosts: [
        {
          transcriptionHost: 'gpu-1',
          health: buildProviderHealth({
            kind: 'local',
            owningWorkers: [buildWorker({ estimatedCapacitySessions: 6 })],
          }),
        },
      ],
    });

    mountFleet([], [], new Map(), [provider]);

    expect(screen.getByText('whisper')).toBeInTheDocument();
    expect(document.body).toHaveTextContent('2 / 6');
  });

  it('renders "not applicable" for a remote provider (lumen_granite), never a fake number', () => {
    const provider = buildMergedProvider({
      providerKey: 'lumen_granite',
      activeSessions: 1,
      hosts: [
        {
          transcriptionHost: 'gpu-1',
          health: buildProviderHealth({ kind: 'remote', owningWorkers: [] }),
        },
      ],
    });

    mountFleet([], [], new Map(), [provider]);

    expect(screen.getByText('lumen_granite')).toBeInTheDocument();
    expect(screen.getByText('not applicable')).toBeInTheDocument();
  });

  it('renders "warming up" for a local provider with no clean measurement yet', () => {
    const provider = buildMergedProvider({
      providerKey: 'whisper',
      activeSessions: 0,
      hosts: [
        {
          transcriptionHost: 'gpu-1',
          health: buildProviderHealth({
            kind: 'local',
            owningWorkers: [buildWorker({ estimatedCapacitySessions: null })],
          }),
        },
      ],
    });

    mountFleet([], [], new Map(), [provider]);

    expect(document.body).toHaveTextContent('0 / warming up');
  });

  it('renders nothing when the fleet reports no providers', () => {
    mountFleet([], [], new Map(), []);

    expect(
      document.querySelector('[aria-label^="Capacity for provider"]'),
    ).toBeNull();
  });

  it('renders the refusal count as visible text when nonzero', () => {
    const provider = buildMergedProvider({
      providerKey: 'whisper',
      sessionsRefusedCapacityTotal: 7,
    });

    mountFleet([], [], new Map(), [provider]);

    expect(screen.getByText('refused 7 (since restart)')).toBeInTheDocument();
  });

  it('renders the zero-refusal case as visible text, not silence', () => {
    // 0 is the honest answer for a provider that has never been refused
    // (every remote provider, and any local one that has never saturated),
    // not a gap - so it must still render as text (SC 1.4.1: never colour or
    // absence alone), distinct from the nonzero "refused N (since restart)"
    // wording so a reader never mistakes it for a live refusal count.
    const provider = buildMergedProvider({
      providerKey: 'lumen_granite',
      sessionsRefusedCapacityTotal: 0,
      hosts: [
        {
          transcriptionHost: 'gpu-1',
          health: buildProviderHealth({ kind: 'remote', owningWorkers: [] }),
        },
      ],
    });

    mountFleet([], [], new Map(), [provider]);

    expect(screen.getByText('0 refused')).toBeInTheDocument();
    expect(
      screen.queryByText(/refused 0 \(since restart\)/),
    ).not.toBeInTheDocument();
  });
});

describe('FleetPanel a11y', (it) => {
  beforeEach(() => {
    vi.mocked(useFleet).mockReset();
  });

  it('has no a11y violations with a populated grid', async () => {
    // The two axe tests added before this one each found a real defect on their
    // first run (a nav list violation, and a skipped heading level), so this is
    // not a formality. Covers the filter chips' aria-pressed, the roll-up's
    // aria-live region, the conventions button, and the card's meter bar.
    const container = mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [
        buildAudio(
          { clippingPct: 0.05, silence: true },
          { sessionUid: 'session-1' },
        ),
      ],
    );

    const results = await axe(container);

    expect(results.violations).toHaveLength(0);
  });

  it('has no a11y violations in the throughput-only state', async () => {
    // A different strip renders here (a caption instead of a meter), so the
    // component-level axe pass on `AudioMeterBar` says nothing about it.
    const container = mountFleet(
      [visibleSession({ sessionUid: 'session-1' })],
      [buildThroughputOnlySnapshot({ sessionUid: 'session-1' })],
    );

    const results = await axe(container);

    expect(results.violations).toHaveLength(0);
  });
});

/**
 * PLAN-VisibleErrors §4.4 at the surface. The bug was never that the panel
 * kept a stale snapshot — mid-incident that snapshot is evidence — it was that
 * it kept one while looking exactly like a live one.
 */
describe('FleetPanel stale telemetry', (it) => {
  beforeEach(() => {
    vi.mocked(useFleet).mockReset();
  });

  function mountStale(
    poll: FleetState['poll'],
    sessions: SessionSnapshot[] = [visibleSession({ sessionUid: 'session-1' })],
  ): HTMLElement {
    const snapshot: FleetSnapshot = {
      generatedAt: 1,
      nodes: [],
      sessions,
      transcriptionHosts: [],
      providers: [],
      sessionAudio: [],
    };
    vi.mocked(useFleet).mockReturnValue({
      snapshot,
      sessionEvents: new Map(),
      connected: true,
      available: true,
      poll,
      refresh: vi.fn(),
    });
    return renderWithProviders(<FleetPanel />).container;
  }

  it('marks the heading, the chip and the grid itself when the poll degrades', () => {
    mountStale({
      status: 'degraded',
      code: 'TELEMETRY_DEGRADED',
      message: 'Could not read live fleet telemetry.',
      lastSuccessAt: Date.now() - 4_000,
      consecutiveFailures: 1,
    });

    // Three independent, text-bearing signals — none of them colour alone, and
    // none of them dependent on the operator scrolling to the same place.
    expect(
      screen.getByRole('heading', { name: /last known state/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/not updating · 4s old/)).toBeInTheDocument();
    expect(screen.getByText(/frozen snapshot/i)).toBeInTheDocument();
  });

  it('states the cause and the next action, not just that something is wrong', () => {
    // No sessions: with any, the audio roll-up's own "metering unavailable"
    // notice is a second `role="alert"` and `getByRole` would be ambiguous.
    mountStale(
      {
        status: 'degraded',
        code: 'TELEMETRY_DEGRADED',
        message: 'Could not read live fleet telemetry.',
        lastSuccessAt: Date.now() - 2_000,
        consecutiveFailures: 1,
      },
      [],
    );

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/not the current state of the fleet/i);
    expect(banner).toHaveTextContent(/Could not read live fleet telemetry/);
    expect(banner).toHaveTextContent(/keeps retrying/i);
    expect(
      screen.getByRole('button', { name: /retry now/i }),
    ).toBeInTheDocument();
  });

  it('escalates to an error banner once the snapshot outlives the stale threshold', () => {
    mountStale(
      {
        status: 'degraded',
        code: 'TELEMETRY_DEGRADED',
        message: 'Could not read live fleet telemetry.',
        lastSuccessAt: Date.now() - FLEET_STALE_AFTER_MS - 1_000,
        consecutiveFailures: 4,
      },
      [],
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      /this is not the live fleet/i,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /do not read this grid as current/i,
    );
  });

  it('keeps the ticking age out of the announced banner', () => {
    // The banner is assertive and the age ticks once a second; a relative age
    // inside it would re-announce itself indefinitely to a screen-reader user.
    mountStale(
      {
        status: 'degraded',
        code: 'TELEMETRY_DEGRADED',
        message: 'Could not read live fleet telemetry.',
        lastSuccessAt: Date.now() - 134_000,
        consecutiveFailures: 20,
      },
      [],
    );

    expect(screen.getByRole('alert')).not.toHaveTextContent('2m 14s');
    // …while the chip, which is in no live region, carries it.
    expect(screen.getByText(/not updating · 2m 14s old/)).toBeInTheDocument();
  });

  it('does not present a frozen empty fleet as "No active sessions."', () => {
    mountStale(
      {
        status: 'degraded',
        code: 'TELEMETRY_DEGRADED',
        message: 'Could not read live fleet telemetry.',
        lastSuccessAt: Date.now() - 2_000,
        consecutiveFailures: 1,
      },
      [],
    );

    expect(
      screen.getByText(/this is the frozen snapshot/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('No active sessions.')).not.toBeInTheDocument();
  });

  it('says the SSE chip is about the stream, not about the data', () => {
    vi.mocked(useFleet).mockReturnValue({
      snapshot: {
        generatedAt: 1,
        nodes: [],
        sessions: [],
        transcriptionHosts: [],
        providers: [],
        sessionAudio: [],
      },
      sessionEvents: new Map(),
      connected: false,
      available: true,
      poll: { status: 'ok', lastSuccessAt: Date.now() },
      refresh: vi.fn(),
    });
    renderWithProviders(<FleetPanel />);

    // A bare "reconnecting…" beside a frozen grid read as a complete account
    // of the panel's health; it never was.
    expect(screen.getByText('live stream reconnecting…')).toBeInTheDocument();
    expect(screen.getByText(/updated \d+s ago/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not say "Loading fleet…" once a read has already failed', () => {
    // A spinner-shaped lie about a request that is not coming.
    vi.mocked(useFleet).mockReturnValue({
      snapshot: null,
      sessionEvents: new Map(),
      connected: false,
      available: true,
      poll: {
        status: 'degraded',
        code: 'TELEMETRY_DEGRADED',
        message: 'Could not read live fleet telemetry.',
        lastSuccessAt: null,
        consecutiveFailures: 2,
      },
      refresh: vi.fn(),
    });
    renderWithProviders(<FleetPanel />);

    expect(screen.queryByText('Loading fleet…')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /does not mean the fleet is idle/i,
    );
  });

  it('shows no staleness marking at all while the poll is healthy', () => {
    mountStale({ status: 'ok', lastSuccessAt: Date.now() - 1_000 }, []);

    expect(
      screen.getByRole('heading', { name: 'Live fleet' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/frozen snapshot/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('has no a11y violations while stale', async () => {
    const container = mountStale({
      status: 'degraded',
      code: 'TELEMETRY_DEGRADED',
      message: 'Could not read live fleet telemetry.',
      lastSuccessAt: Date.now() - FLEET_STALE_AFTER_MS - 1_000,
      consecutiveFailures: 4,
    });

    const results = await axe(container);

    expect(results.violations).toHaveLength(0);
  });
});
