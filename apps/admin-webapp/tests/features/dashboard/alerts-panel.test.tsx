import { screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, vi } from 'vitest';

import { AlertsPanel } from '#src/features/dashboard/alerts-panel';
import type { AlertsState } from '#src/features/dashboard/use-alerts';
import { useAlerts } from '#src/features/dashboard/use-alerts';
import type { MonitoringAlert } from '#src/lib/admin-api';

import { renderWithProviders } from '../../utils/render-with-providers';

vi.mock('#src/features/dashboard/use-alerts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('#src/features/dashboard/use-alerts')>();
  return { ...actual, useAlerts: vi.fn() };
});

function fakeAlert(overrides: Partial<MonitoringAlert> = {}): MonitoringAlert {
  return {
    id: 'asr-worker-dead',
    failureModes: ['T9'],
    severity: 'critical',
    summary: '1 transcription worker process(es) have exited (worker 0).',
    likelyCause:
      'A worker died after startup — most often a model-load crash, a GPU fault or an OOM kill.',
    stage: 'transcription',
    value: 1,
    threshold: 0,
    ...overrides,
  };
}

function mount(state: AlertsState) {
  vi.mocked(useAlerts).mockReturnValue({ state, refresh: vi.fn() });
  return renderWithProviders(<AlertsPanel />).container;
}

describe('AlertsPanel', (it) => {
  it('renders nothing while the first read is in flight', () => {
    const container = mount({ status: 'loading' });

    expect(container).toBeEmptyDOMElement();
  });

  it('renders an assertive error notice when the sidecar could not be asked, never an empty-looking panel', () => {
    // The exact bug this panel exists to avoid: a fetch failure must not
    // silently read as "no alerts firing".
    mount({
      status: 'unavailable',
      message:
        "monitoring-sidecar's /api/monitoring/v1/alerts answered HTTP 500.",
      severity: 'error',
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      /could not read monitoring-sidecar alerts/i,
    );
    expect(alert).toHaveTextContent(/answered HTTP 500/);
    // The healthy empty-list sentence must not also render — that would put
    // both messages on screen and blur the exact distinction this panel exists
    // to draw.
    expect(screen.queryByText(/every monitored rule/i)).not.toBeInTheDocument();
  });

  it('renders the healthy "no alerts firing" state distinctly from unavailable', () => {
    mount({ status: 'ok', alerts: [], generatedAt: 'now' });

    expect(screen.getByText(/no alerts firing/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders a critical alert with its cause, mapped to the "error" chip label', () => {
    mount({
      status: 'ok',
      alerts: [fakeAlert({ severity: 'critical' })],
      generatedAt: 'now',
    });

    expect(screen.getByText('error')).toBeInTheDocument();
    expect(
      screen.getByText(/transcription worker process\(es\) have exited/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/most often a model-load crash/),
    ).toBeInTheDocument();
  });

  it('renders a warning alert with the "warning" chip label, not "error"', () => {
    mount({
      status: 'ok',
      alerts: [
        fakeAlert({
          id: 'asr-falling-behind:whisper',
          severity: 'warning',
          summary:
            'Transcription for whisper is using 60% of its realtime budget.',
        }),
      ],
      generatedAt: 'now',
    });

    expect(screen.getByText('warning')).toBeInTheDocument();
    expect(screen.queryByText('error: 1')).not.toBeInTheDocument();
    expect(screen.getByText('error: 0')).toBeInTheDocument();
  });

  it('summarizes mixed severities in the polite live-region rollup', () => {
    mount({
      status: 'ok',
      alerts: [
        fakeAlert({ id: 'a', severity: 'critical' }),
        fakeAlert({ id: 'b', severity: 'warning' }),
        fakeAlert({ id: 'c', severity: 'warning' }),
      ],
      generatedAt: 'now',
    });

    const rollup = screen.getByLabelText('Pipeline alert summary');
    expect(rollup).toHaveTextContent('error: 1');
    expect(rollup).toHaveTextContent('warning: 2');
  });

  it('has no a11y violations with a populated alert list', async () => {
    const container = mount({
      status: 'ok',
      alerts: [
        fakeAlert({ id: 'a', severity: 'critical' }),
        fakeAlert({ id: 'b', severity: 'warning' }),
      ],
      generatedAt: 'now',
    });

    const results = await axe(container);

    expect(results.violations).toHaveLength(0);
  });

  it('renders a rate-limited read as a warning, not as a broken pipeline', () => {
    // admin-server rate limits every route globally, and this panel polls
    // /alerts every 15 s — so a 429 here is "ask again shortly", not "the
    // pipeline's health is unknown because something is broken".
    mount({
      status: 'unavailable',
      message:
        'Too many requests — the admin server is rate limiting this browser. Nothing was changed; wait 1 minute, then try again.',
      severity: 'warning',
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/wait 1 minute, then try again/);
    expect(alert.className).toContain('MuiAlert-colorWarning');
    expect(alert.className).not.toContain('MuiAlert-colorError');
  });

  it('has no a11y violations in the unavailable state', async () => {
    const container = mount({
      status: 'unavailable',
      message: 'did not answer within 3000ms.',
      severity: 'error',
    });

    const results = await axe(container);

    expect(results.violations).toHaveLength(0);
  });
});
