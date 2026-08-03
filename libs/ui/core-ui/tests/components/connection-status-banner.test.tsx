import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConnectionStatusBanner } from '#src/components/connection-status-banner.js';

import { axeViolations } from '../a11y.js';

describe('ConnectionStatusBanner', (it) => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ConnectionStatusBanner
        open={false}
        severity="warning"
        message="Reconnecting…"
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces the message via role=alert when open', () => {
    render(
      <ConnectionStatusBanner
        open
        severity="error"
        message="Lost connection to the transcription service."
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Lost connection to the transcription service.',
    );
  });

  it('announces severity="info" politely via role=status, not role=alert', () => {
    render(
      <ConnectionStatusBanner
        open
        severity="info"
        message="Waiting for the room's microphone to connect."
      />,
    );

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(
      "Waiting for the room's microphone to connect.",
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an info icon for severity="info", hidden from assistive tech', () => {
    render(<ConnectionStatusBanner open severity="info" message="Waiting…" />);

    const icon = screen.getByTestId('InfoOutlinedIcon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByTestId('WarningAmberIcon')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('ErrorOutlineOutlinedIcon'),
    ).not.toBeInTheDocument();
  });

  it('shows a warning icon for severity="warning", hidden from assistive tech', () => {
    render(
      <ConnectionStatusBanner open severity="warning" message="Retrying…" />,
    );

    const icon = screen.getByTestId('WarningAmberIcon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(
      screen.queryByTestId('ErrorOutlineOutlinedIcon'),
    ).not.toBeInTheDocument();
  });

  it('shows an error icon for severity="error", hidden from assistive tech', () => {
    render(
      <ConnectionStatusBanner
        open
        severity="error"
        message="Connection lost."
      />,
    );

    const icon = screen.getByTestId('ErrorOutlineOutlinedIcon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByTestId('WarningAmberIcon')).not.toBeInTheDocument();
  });

  it('has no axe violations when open (info)', async () => {
    render(
      <ConnectionStatusBanner
        open
        severity="info"
        message="Waiting for the room's microphone to connect."
      />,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('has no axe violations when open (warning)', async () => {
    render(
      <ConnectionStatusBanner
        open
        severity="warning"
        message="Reconnecting to the transcription service…"
      />,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('has no axe violations when open (error)', async () => {
    render(
      <ConnectionStatusBanner
        open
        severity="error"
        message="Lost connection to the transcription service."
      />,
    );
    expect(await axeViolations()).toEqual([]);
  });
});
