import type { ReactElement } from 'react';

import { screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, vi } from 'vitest';

import { useFleet } from '#src/features/dashboard/use-fleet';
import { SessionDetailPage } from '#src/features/sessions/session-detail-page';
import type { SessionAudioSnapshot } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import {
  buildAudioSnapshot,
  buildLevels,
  buildThroughputOnlySnapshot,
  buildVadDisabled,
  buildVadStats,
  stageAsrInput,
  stageIngress,
  stageVad,
} from '../dashboard/audio-fixtures';
import { buildRoom, buildSession } from './fixtures';

vi.mock('#src/lib/admin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/lib/admin-api')>();
  return {
    ...actual,
    adminApi: {
      getSession: vi.fn(),
      getSessionJoinCode: vi.fn(),
      getRoom: vi.fn(),
    },
  };
});

vi.mock('#src/features/dashboard/use-fleet', () => ({
  useFleet: vi.fn(() => ({
    snapshot: null,
    sessionEvents: new Map(),
    connected: false,
    available: false,
    refresh: vi.fn(),
  })),
}));

const SESSION_UID = 'session-1';

function renderPage(ui: ReactElement = <SessionDetailPage />) {
  return renderWithProviders(
    <Routes>
      <Route path="/sessions/:sessionUid" element={ui} />
    </Routes>,
    { route: `/sessions/${SESSION_UID}` },
  );
}

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

describe('SessionDetailPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Neutral default so tests unrelated to the join-code section don't have
    // to stub it individually; overridden per-case below.
    // The page reads the session's room for its timezone alone; default it
    // to the browser's own zone so unrelated cases print unchanged times.
    vi.mocked(adminApi.getRoom).mockResolvedValue(
      buildRoom({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    );
    vi.mocked(adminApi.getSessionJoinCode).mockResolvedValue({
      status: 'not-active',
      joinCode: null,
      validEnd: null,
    });
  });

  describe('loading', (it) => {
    it('shows a spinner while the initial load is in flight', () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );

      // Act
      renderPage();

      // Assert
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('not-found state', (it) => {
    it('shows "Session not found." on a 404 ApiError', async () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockRejectedValue(
        new ApiError('NOT_FOUND', 'no such session', 404),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(await screen.findByText('Session not found.')).toBeInTheDocument();
    });
  });

  describe('error state', (it) => {
    it('shows a toast and the not-found fallback on a non-404, non-ApiError rejection', async () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockRejectedValue(
        new Error('network down'),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText('Failed to load session.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Session not found.')).toBeInTheDocument();
    });
  });

  describe('BACKEND_MISCONFIGURATION', (it) => {
    it('shows the ADMIN_API_KEY alert as the entire page body', async () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockRejectedValue(
        new ApiError('BACKEND_MISCONFIGURATION', 'nope', 502),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(/admin backend misconfiguration/i),
      ).toBeInTheDocument();
      expect(screen.queryByText('Session not found.')).not.toBeInTheDocument();
    });
  });

  describe('loaded state', (it) => {
    it('renders the session fields once loaded', async () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({ name: 'CS 225 Lecture', roomUid: 'room-1' }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('CS 225 Lecture')).toBeInTheDocument();
      expect(screen.getByText('room-1')).toBeInTheDocument();
    });
  });

  describe('join session', (it) => {
    beforeEach(() => {
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({ name: 'CS 225 Lecture', roomUid: 'room-1' }),
      );
    });

    it('shows a muted message when the session has no join code scopes', async () => {
      // Arrange
      vi.mocked(adminApi.getSessionJoinCode).mockResolvedValue({
        status: 'no-join-scopes',
        joinCode: null,
        validEnd: null,
      });

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(
          'No join code scopes configured for this session.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: /open live captions/i }),
      ).not.toBeInTheDocument();
    });

    it('shows a muted message when the session is not currently active', async () => {
      // Arrange
      vi.mocked(adminApi.getSessionJoinCode).mockResolvedValue({
        status: 'not-active',
        joinCode: null,
        validEnd: null,
      });

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(
          'Session is not currently active — no join code available.',
        ),
      ).toBeInTheDocument();
    });

    it('shows the join code, copy buttons, and an open-live-captions link when active', async () => {
      // Arrange
      vi.mocked(adminApi.getSessionJoinCode).mockResolvedValue({
        status: 'ok',
        joinCode: 'ABC12345',
        validEnd: '2026-08-01T00:05:00.000Z',
      });

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(await screen.findByText('ABC12345')).toBeInTheDocument();
      const link = screen.getByRole('link', {
        name: /open live captions/i,
      });
      expect(link).toHaveAttribute(
        'href',
        expect.stringContaining('/client/#config='),
      );
      expect(
        screen.getAllByRole('button', { name: /copy join/i }),
      ).toHaveLength(2);
    });
  });
  describe('audio health', (it) => {
    // A `Session` here is a *scheduled* record: this page is reachable for a
    // class that ended last term and for one starting next week. Live audio
    // telemetry only exists inside the effective window, so outside it the
    // absence of a snapshot is expected — warning the operator to go check a
    // microphone would be a false alarm on most detail-page views.
    const MIC_WARNING = /microphone is unmuted/;

    /** The shipped whisper graph for this page's session, freshly published. */
    function audioSnapshot(
      overrides: Partial<SessionAudioSnapshot> = {},
    ): SessionAudioSnapshot {
      return buildAudioSnapshot({
        updatedAt: Date.now(),
        sessionUid: SESSION_UID,
        stages: [stageIngress(), stageAsrInput()],
        ...overrides,
      });
    }

    function mockFleet(audio: SessionAudioSnapshot[]): void {
      vi.mocked(useFleet).mockReturnValue({
        snapshot: {
          generatedAt: 1,
          nodes: [],
          sessions: [],
          transcriptionHosts: [],
          providers: [],
          sessionAudio: audio,
        },
        sessionEvents: new Map(),
        connected: true,
        available: true,
        refresh: vi.fn(),
      });
    }

    it('does not warn about the microphone for a session that has not started', async () => {
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2099-01-01T14:00:00.000Z',
          effectiveEnd: '2099-01-01T15:00:00.000Z',
        }),
      );

      renderPage();

      expect(
        await screen.findByText(/has not started yet/),
      ).toBeInTheDocument();
      expect(screen.queryByText(MIC_WARNING)).not.toBeInTheDocument();
    });

    it('does not warn about the microphone for a session that has ended', async () => {
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: '2000-01-01T15:00:00.000Z',
        }),
      );

      renderPage();

      expect(await screen.findByText(/has ended/)).toBeInTheDocument();
      expect(screen.queryByText(MIC_WARNING)).not.toBeInTheDocument();
    });

    it('does not subscribe to fleet telemetry outside the session window', async () => {
      // The live view holds an SSE connection and re-reads /fleet on the poll
      // interval; a session that cannot be on the air should pay neither cost.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: '2000-01-01T15:00:00.000Z',
        }),
      );

      renderPage();
      await screen.findByText(/has ended/);

      expect(vi.mocked(useFleet)).not.toHaveBeenCalled();
    });

    it('warns about the microphone when a session inside its window has no audio', async () => {
      // Inside the window the absence really is failure mode C1.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([]);

      renderPage();

      expect(await screen.findByText(MIC_WARNING)).toBeInTheDocument();
    });

    it('says which peak convention it is showing', async () => {
      // The publisher's peakDbfs is a window maximum; the standalone meter's
      // headline "Peak" is a hold-and-decay meter and reads lower on the same
      // audio. An operator comparing the two screens has to be told, or the
      // mismatch reads as a bug in one of them.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([audioSnapshot()]);

      renderPage();

      expect(
        await screen.findByText('Peak (10 s window max)'),
      ).toBeInTheDocument();
      // The convention itself is the button's accessible name, not only a
      // tooltip: MUI wires a tooltip up via aria-describedby only while open.
      const note = screen.getByRole('button', {
        name: /hold-and-decay meter/i,
      });
      expect(note).toBeInTheDocument();
      expect(note).toHaveAccessibleName(/Session max true peak/);
    });

    it('labels the RMS, clipping and noise-floor conventions too', async () => {
      // PLAN-AUDIOVIZ §8: conventions must be labelled on the surface. These are
      // definitions an operator cannot infer from the figure.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([audioSnapshot()]);

      renderPage();

      expect(await screen.findByText('RMS (10 s window)')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /full-scale sine reads/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /10th-percentile RMS/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /runs of at least two/i }),
      ).toBeInTheDocument();
    });

    it('has no a11y violations with a full audio readout', async () => {
      // The convention notes added four focusable controls to this section, and
      // the meter carries role="progressbar"; check the section as rendered
      // rather than trusting the component-level axe test on the bar alone.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([
        audioSnapshot({
          stages: [stageIngress(), stageAsrInput(), stageVad()],
        }),
      ]);

      const { container } = renderPage();
      await screen.findByText('Peak (10 s window max)');

      const results = await axe(container);
      expect(results.violations).toHaveLength(0);
    });

    it('renders VAD-not-enabled as "not measured", never 0%', async () => {
      // §6.2 is the whole reason the three-state rendering exists: vadEnabled
      // false means VAD never ran, so every other field is null. Rendering that
      // as 0% would read as "silence" when it means "not measured" — actively
      // misleading, and the one thing a UI gets wrong here by default.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([
        audioSnapshot({
          stages: [
            stageIngress(),
            stageVad({ vad: buildVadDisabled(), audioSeconds: null }),
          ],
        }),
      ]);

      renderPage();

      expect(
        await screen.findByText('VAD was not enabled for this session.'),
      ).toBeInTheDocument();
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
      expect(screen.queryByText('0% speech')).not.toBeInTheDocument();
    });

    it('distinguishes "no detector in this pipeline" from "the detector did not run"', async () => {
      // Two different absences, and §6.2's whole point is that a UI must not
      // collapse them: only whisper reports a `vad` stage at all (§12.3), so most
      // sessions have no detector anywhere — which is not the same claim as a
      // configured detector that stayed off.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([audioSnapshot({ stages: [stageIngress(), stageAsrInput()] })]);

      renderPage();

      expect(
        await screen.findByText(
          'No measurement point in this pipeline runs a voice-activity detector.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('VAD was not enabled for this session.'),
      ).not.toBeInTheDocument();
    });

    it('renders a measured-but-absent VAD field as an em-dash with a reason', async () => {
      // The other half of §6.2: VAD ran, but a field is structurally null.
      // segmentCount 0 nulls meanSegmentDurationSec (no segment to average),
      // which is "not measured", not zero seconds.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([
        audioSnapshot({
          stages: [
            stageIngress(),
            stageVad({
              vad: buildVadStats({
                speechActiveRatio: 0,
                segmentCount: 0,
                meanSegmentDurationSec: null,
                speechToPauseRatio: 0,
                snrDb: null,
              }),
            }),
          ],
        }),
      ]);

      renderPage();

      await screen.findByText('Mean segment');
      // The em-dash is focusable so a keyboard user can reach the explanation
      // (SC 2.1.1); its tooltip says why the value is absent.
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
      expect(screen.queryByText('0.00 s')).not.toBeInTheDocument();
    });

    it('renders the audio readout for a session inside its window with telemetry', async () => {
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([
        audioSnapshot({
          stages: [
            stageIngress({ levels: buildLevels({ clippingPct: 0.05 }) }),
          ],
        }),
      ]);

      renderPage();

      // Clipping is a fraction on the wire: 0.05 is 5% of samples, not 0.05%.
      expect(await screen.findByText('5.00%')).toBeInTheDocument();
      expect(screen.queryByText(MIC_WARNING)).not.toBeInTheDocument();
    });

    it('names the stage the headline readout was measured at', async () => {
      // §12.8 point 1 is a behaviour change to a shipped signal: a green audio
      // chip now asserts "the source is sending good audio" and nothing about the
      // ASR. An operator can only know that if the surface says where it looked.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([audioSnapshot()]);

      renderPage();

      expect(await screen.findByText('Measured at')).toBeInTheDocument();
      expect(screen.getByText('Source ingress (depth 1)')).toBeInTheDocument();
    });

    it('says metering is unavailable, rather than showing a level, for a throughput-only provider', async () => {
      // The `debug` provider's shape (§12.3): seconds and no meter. A bar at rest
      // would read as silence and a blank space as "nothing to report"; both are
      // the false green §12.8 point 1 forbids.
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([
        buildThroughputOnlySnapshot({
          updatedAt: Date.now(),
          sessionUid: SESSION_UID,
        }),
      ]);

      renderPage();

      expect(
        await screen.findByText(/Pipeline metering unavailable/),
      ).toBeInTheDocument();
      expect(screen.queryByText('RMS (10 s window)')).not.toBeInTheDocument();
      // The stage table still renders: throughput is what this provider reports,
      // and it answers "is audio reaching the ASR".
      expect(screen.getByText('33.6 s')).toBeInTheDocument();
    });
  });

  describe('processing pipeline table', (it) => {
    function mockFleet(audio: SessionAudioSnapshot[]): void {
      vi.mocked(useFleet).mockReturnValue({
        snapshot: {
          generatedAt: 1,
          nodes: [],
          sessions: [],
          transcriptionHosts: [],
          providers: [],
          sessionAudio: audio,
        },
        sessionEvents: new Map(),
        connected: true,
        available: true,
        refresh: vi.fn(),
      });
    }

    function renderLiveSession() {
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      return renderPage();
    }

    function liveSnapshot(
      overrides: Partial<SessionAudioSnapshot> = {},
    ): SessionAudioSnapshot {
      return buildAudioSnapshot({
        updatedAt: Date.now(),
        sessionUid: SESSION_UID,
        ...overrides,
      });
    }

    it('renders a real table with column headers, one row per measurement point', async () => {
      // A div grid would look identical and be unreadable with a screen reader:
      // these rows are a relation an operator reads across, so each cell needs
      // its column header announced with it.
      mockFleet([liveSnapshot()]);

      renderLiveSession();

      const table = await screen.findByRole('table');
      expect(table).toBeInTheDocument();
      expect(
        screen.getByRole('columnheader', { name: 'Change from upstream' }),
      ).toBeInTheDocument();
      // Three stages in the shipped whisper graph, each a row header.
      expect(
        screen.getByRole('rowheader', { name: /Source ingress/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('rowheader', { name: /VAD \(Silero\)/ }),
      ).toBeInTheDocument();
    });

    it('does not flag the normal skew between two counters as loss', async () => {
      // The default fixture is §12.4's healthy payload: ingress 0.5 s ahead of
      // asr_input. A naive `> 0` check would put "audio is being lost" on every
      // session in the fleet.
      mockFleet([liveSnapshot()]);

      renderLiveSession();

      await screen.findByRole('table');
      expect(screen.getByText(/within tolerance/)).toBeInTheDocument();
      expect(screen.queryByText(/lost from/)).not.toBeInTheDocument();
    });

    it('flags loss past the tolerance against the edge that lost it', async () => {
      mockFleet([
        liveSnapshot({
          stages: [
            stageIngress({ audioSeconds: 120 }),
            stageAsrInput({ audioSeconds: 100 }),
          ],
        }),
      ]);

      renderLiveSession();

      await screen.findByRole('table');
      // Named by its upstream stage id, in the downstream stage's row — the
      // attribution `inputs` exists to make possible (§12.2).
      expect(screen.getByText('20.0 s lost from ingress')).toBeInTheDocument();
    });

    it('calls the drop across a detector gating rather than loss', async () => {
      // The shipped whisper graph passes ~47 s of speech out of ~123 s of audio.
      // Reporting that as loss would put a large red figure on every VAD-enabled
      // session — the same class of false alarm §12.1 removed.
      mockFleet([liveSnapshot()]);

      renderLiveSession();

      await screen.findByRole('table');
      expect(
        screen.getByText('75.7 s gated from asr_input'),
      ).toBeInTheDocument();
    });

    it('renders an em-dash with a reason where the comparison is not derivable', async () => {
      // Showing 0 s would be a claim the data does not support: one end of the
      // edge does not count seconds at all.
      mockFleet([
        liveSnapshot({
          stages: [
            stageIngress({ audioSeconds: null }),
            stageAsrInput({ audioSeconds: 100 }),
          ],
        }),
      ]);

      renderLiveSession();

      await screen.findByRole('table');
      const notDerivable = screen.getAllByText('—');
      expect(notDerivable.length).toBeGreaterThan(0);
      // No edge in this graph is derivable, so *no* comparison may appear —
      // asserting only on the em-dash is too weak, because a `?? 0` fallback
      // would still leave em-dashes in the other cells while quietly inventing a
      // comparison here.
      expect(screen.queryByText(/within tolerance/)).not.toBeInTheDocument();
      expect(screen.queryByText(/lost from/)).not.toBeInTheDocument();
      expect(screen.queryByText(/gated from/)).not.toBeInTheDocument();
    });

    it('renders a stage that meters nothing as an em-dash, not as a level', async () => {
      // `levels: null` means "this point counts throughput only" — a statement
      // about the measurement point, not about the audio. Any number here would
      // be invented.
      mockFleet([
        liveSnapshot({
          stages: [stageIngress(), stageVad()],
        }),
      ]);

      renderLiveSession();

      await screen.findByRole('table');
      const vadRow = screen.getByRole('rowheader', {
        name: /VAD \(Silero\)/,
      }).parentElement;
      expect(vadRow?.textContent).toContain('—');
      expect(vadRow?.textContent).not.toContain('dBFS');
    });

    it('marks which row the audio status came from', async () => {
      // The table and the chip above it must not be able to disagree about which
      // reading is "the" reading.
      mockFleet([liveSnapshot()]);

      renderLiveSession();

      await screen.findByRole('table');
      const ingressRow = screen.getByRole('rowheader', {
        name: /Source ingress/,
      });
      expect(ingressRow.textContent).toContain('status source');
    });

    it('has no a11y violations with the full pipeline table rendered', async () => {
      // New markup with header cells, a caption, focusable em-dashes and a
      // convention note inside a cell — none of which the component-level axe
      // passes cover.
      mockFleet([liveSnapshot()]);

      // Axe the rendered container, not `document.body`: the page is a fragment
      // without the app shell's landmarks here, so body-level scanning reports a
      // `region` violation that belongs to the harness rather than the table.
      const { container } = renderLiveSession();

      await screen.findByRole('table');
      const results = await axe(container);
      expect(results.violations).toHaveLength(0);
    });
  });
});
