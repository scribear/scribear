import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { beforeEach, describe, expect, vi } from 'vitest';

import {
  DEFAULT_DURATION_SEC,
  DEFAULT_GOOD_PARAMS,
} from '#src/features/test-audio/params-meta';
import { TestAudioPage } from '#src/features/test-audio/test-audio-page';
import { adminApi } from '#src/lib/admin-api';

import { renderWithProviders } from '../../utils/render-with-providers';
import {
  buildDeviceState,
  buildFaultDeviceState,
  buildStatus,
} from './fixtures';

// The BFF routes are mocked, the way every other page's tests mock them. This
// page is built against the §3 contract, not against a running admin-server.
vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    testAudio: vi.fn(),
    startTestAudio: vi.fn(),
    stopTestAudio: vi.fn(),
    updateTestAudioParams: vi.fn(),
  },
}));

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

/** Renders the page with the given `GET /test-audio` body and waits it out. */
async function renderPage(status = buildStatus()): Promise<HTMLElement> {
  vi.mocked(adminApi.testAudio).mockResolvedValue(status);
  const { container } = renderWithProviders(<TestAudioPage />);
  await waitForLoad();
  return container;
}

/** Opens the good source's clip select and picks the Apollo fixture. An
 *  immediate (non-debounced) control, so it isolates the retune-vs-start rule
 *  from the slider's debounce. */
async function chooseApolloClip() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: 'Speech clip' }));
  await user.click(screen.getByRole('option', { name: /Apollo/ }));
}

describe('TestAudioPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(adminApi.startTestAudio).mockResolvedValue(buildDeviceState());
    vi.mocked(adminApi.stopTestAudio).mockResolvedValue(buildDeviceState());
    vi.mocked(adminApi.updateTestAudioParams).mockResolvedValue(
      buildDeviceState(),
    );
  });

  describe('an unconfigured deployment', (it) => {
    it('names what the deployment has not set instead of raising an error', async () => {
      // Arrange
      const status = buildStatus({ available: false, devices: [] });

      // Act
      await renderPage(status);

      // Assert
      expect(screen.getAllByText('TEST_AUDIO_BASE_URL').length).toBeGreaterThan(
        0,
      );
      expect(screen.getByText(/not configured here/i)).toBeInTheDocument();
      expect(screen.getByText(/provision-test-audio\.sh/)).toBeInTheDocument();
    });

    it('offers nothing to start, rather than a control that would 503', async () => {
      // Arrange
      const status = buildStatus({ available: false, devices: [] });

      // Act
      await renderPage(status);

      // Assert
      expect(
        screen.queryByRole('button', { name: /Start the good source/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    });

    it('states it informationally rather than as a failure', async () => {
      // An unprovisioned deployment is a deployment choice, not a fault (§3),
      // so this must not read as something the operator broke. The toast host
      // renders nothing while closed, so the single alert on screen is the
      // page's own — and it must be the info variant.
      // Arrange / Act
      await renderPage(buildStatus({ available: false, devices: [] }));

      // Assert
      const alerts = screen.getAllByRole('alert');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.className).toContain('MuiAlert-colorInfo');
      expect(alerts[0]?.className).not.toContain('MuiAlert-colorError');
    });
  });

  describe('controls', (it) => {
    it('gives every good-source control an accessible name', async () => {
      // Arrange / Act
      await renderPage();

      // Assert
      expect(
        screen.getByRole('combobox', { name: 'Speech clip' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('slider', { name: 'Gain for the good source' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('group', { name: 'Noise type for the good source' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('radiogroup', { name: 'Noise floor' }),
      ).toBeInTheDocument();
    });

    it('renders one named slider per fault knob', async () => {
      // The §2.2 table has nine knobs; a missing one is a fault an operator
      // cannot reproduce from this page at all.
      // Arrange / Act
      await renderPage();

      // Assert
      for (const name of [
        'Hard clipping for the fault source',
        'Repeated frames (stutter) for the fault source',
        'Dropped frames for the fault source',
        'Send-rate multiple for the fault source',
        'Digital silence for the fault source',
        'DC bias for the fault source',
        'Corrupt frames (bad CRC / truncated) for the fault source',
        'Wrong-sample-rate WAV header for the fault source',
        'Clock skew written into sentAt for the fault source',
      ]) {
        expect(screen.getByRole('slider', { name })).toBeInTheDocument();
      }
    });

    it('captions each fault knob with what it is expected to trip', async () => {
      // The page doubles as the documentation for §2.2, so the caption is
      // load-bearing content, not decoration.
      // Arrange / Act
      await renderPage();

      // Assert
      expect(
        screen.getByText(/asr-audio-too-fast CRITICAL/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/scribear_safp_decode_drops_total/),
      ).toBeInTheDocument();
      expect(screen.getByText(/clock-skew WARNING/)).toBeInTheDocument();
    });

    it('refuses to start a device with no token, and says why', async () => {
      // Arrange
      const status = buildStatus({
        devices: [
          buildDeviceState({ configured: false }),
          buildFaultDeviceState(),
        ],
      });

      // Act
      await renderPage(status);

      // Assert
      expect(
        screen.getByRole('button', { name: /Start the good source/ }),
      ).toBeDisabled();
      expect(screen.getByText(/No device token is set/)).toBeInTheDocument();
    });
  });

  describe('starting an idle device', (it) => {
    it('posts the staged parameters and the duration', async () => {
      // Arrange
      await renderPage();
      await chooseApolloClip();

      // Act
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: /Start the good source/ }));

      // Assert
      expect(adminApi.startTestAudio).toHaveBeenCalledWith('good', {
        params: { ...DEFAULT_GOOD_PARAMS, clip: 'apollo' },
        durationSec: DEFAULT_DURATION_SEC,
      });
    });

    it('does not PATCH while the device is idle', async () => {
      // §4: on an idle device a control change is local state only, applied at
      // start. A PATCH here would be a 409 — there is no run to retune.
      // Arrange
      await renderPage();

      // Act
      await chooseApolloClip();

      // Assert
      expect(adminApi.updateTestAudioParams).not.toHaveBeenCalled();
    });
  });

  describe('a running device', (it) => {
    const runningStatus = () =>
      buildStatus({
        devices: [
          buildDeviceState({
            state: 'streaming',
            sessionUid: 'session-1',
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
            framesSent: 42,
          }),
          buildFaultDeviceState(),
        ],
      });

    it('retunes rather than restarting when a control changes', async () => {
      // The whole point of the feature: a restart would drop the session the
      // operator is watching.
      // Arrange
      await renderPage(runningStatus());

      // Act
      await chooseApolloClip();

      // Assert
      expect(adminApi.updateTestAudioParams).toHaveBeenCalledWith('good', {
        clip: 'apollo',
      });
      expect(adminApi.startTestAudio).not.toHaveBeenCalled();
    });

    it('sends one retune for a slider that is dragged, not one per step', async () => {
      // Arrange
      await renderPage(runningStatus());
      const gain = screen.getByRole('slider', {
        name: 'Gain for the good source',
      });

      // Act
      fireEvent.change(gain, { target: { value: '5' } });
      fireEvent.change(gain, { target: { value: '9' } });

      // Assert
      await waitFor(() => {
        expect(adminApi.updateTestAudioParams).toHaveBeenCalledWith('good', {
          gainDb: 9,
        });
      });
      expect(adminApi.updateTestAudioParams).toHaveBeenCalledTimes(1);
    });

    it('offers stop instead of start, and shows the run counters', async () => {
      // Arrange / Act
      await renderPage(runningStatus());

      // Assert
      expect(
        screen.getByRole('button', { name: /Stop the good source/ }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Start the good source/ }),
      ).not.toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
    });
  });

  describe('a11y', (it) => {
    it('has no violations with both devices rendered', async () => {
      // Arrange
      const container = await renderPage();

      // Act
      const results = await axe(container);

      // Assert
      expect(results.violations).toHaveLength(0);
    });

    it('has no violations in the unconfigured state', async () => {
      // A different tree renders here, so the pass above says nothing about it.
      // Arrange
      const container = await renderPage(
        buildStatus({ available: false, devices: [] }),
      );

      // Act
      const results = await axe(container);

      // Assert
      expect(results.violations).toHaveLength(0);
    });
  });
});
