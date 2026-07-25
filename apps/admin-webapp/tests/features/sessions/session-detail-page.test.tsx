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
import { buildSession } from './fixtures';

vi.mock('#src/lib/admin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/lib/admin-api')>();
  return {
    ...actual,
    adminApi: {
      getSession: vi.fn(),
      getSessionJoinCode: vi.fn(),
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

    function audioSnapshot(
      overrides: Partial<SessionAudioSnapshot> = {},
    ): SessionAudioSnapshot {
      return {
        rmsDbfs: -23.4,
        peakDbfs: -12.1,
        clippingPct: 0,
        silence: false,
        noiseFloorDbfs: -65,
        updatedAt: Date.now(),
        vadStats: null,
        sessionUid: SESSION_UID,
        roomUid: null,
        transcriptionHost: 'ts-a',
        ...overrides,
      };
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
          vadStats: {
            vadEnabled: true,
            speechActiveRatio: 0.42,
            segmentCount: 3,
            meanSegmentDurationSec: 1.2,
            speechToPauseRatio: 0.72,
            snrDb: 18.5,
          },
        }),
      ]);

      const { container } = renderPage();
      await screen.findByText('Peak (10 s window max)');

      const results = await axe(container);
      expect(results.violations).toHaveLength(0);
    });

    it('renders the audio readout for a session inside its window with telemetry', async () => {
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({
          effectiveStart: '2000-01-01T14:00:00.000Z',
          effectiveEnd: null,
        }),
      );
      mockFleet([
        {
          rmsDbfs: -23.4,
          peakDbfs: -12.1,
          clippingPct: 0.05,
          silence: false,
          noiseFloorDbfs: -65,
          updatedAt: Date.now(),
          vadStats: null,
          sessionUid: SESSION_UID,
          roomUid: null,
          transcriptionHost: 'ts-a',
        },
      ]);

      renderPage();

      // Clipping is a fraction on the wire: 0.05 is 5% of samples, not 0.05%.
      expect(await screen.findByText('5.00%')).toBeInTheDocument();
      expect(screen.queryByText(MIC_WARNING)).not.toBeInTheDocument();
    });
  });
});
