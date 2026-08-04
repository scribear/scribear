import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useMetricsOverlay } from '#src/features/metrics-overlay/use-metrics-overlay';

/**
 * Minimal host for the hook: renders one line per visible overlay plus a text
 * input, so keystrokes can be aimed at a field the user is typing into.
 */
const Harness = () => {
  const visibleMetrics = useMetricsOverlay();
  return (
    <div>
      <input aria-label="join code" />
      {visibleMetrics.has('latency') && <span>latency overlay</span>}
      {visibleMetrics.has('translation') && <span>translation overlay</span>}
    </div>
  );
};

function renderWithFragment(hash: string) {
  window.location.hash = hash;
  render(<Harness />);
}

function latencyOverlay() {
  return screen.queryByText('latency overlay');
}

function translationOverlay() {
  return screen.queryByText('translation overlay');
}

afterEach(() => {
  window.location.hash = '';
});

describe('useMetricsOverlay', () => {
  it('hides metrics when the fragment does not ask for them', () => {
    renderWithFragment('');
    expect(latencyOverlay()).not.toBeInTheDocument();
  });

  it('shows only the named metric on load', () => {
    renderWithFragment('#metrics=latency');
    expect(latencyOverlay()).toBeInTheDocument();
    expect(translationOverlay()).not.toBeInTheDocument();
  });

  it('shows several named metrics', () => {
    renderWithFragment('#metrics=translation,latency');
    expect(latencyOverlay()).toBeInTheDocument();
    expect(translationOverlay()).toBeInTheDocument();
  });

  it('shows every metric for "all"', () => {
    renderWithFragment('#metrics=all');
    expect(latencyOverlay()).toBeInTheDocument();
    expect(translationOverlay()).toBeInTheDocument();
  });

  it('shows nothing for a fragment naming only unknown metrics', () => {
    renderWithFragment('#metrics=dropouts');
    expect(latencyOverlay()).not.toBeInTheDocument();
  });

  it('reveals every metric when "m" is pressed without a fragment', () => {
    renderWithFragment('');
    fireEvent.keyDown(window, { key: 'm' });
    expect(latencyOverlay()).toBeInTheDocument();
    expect(translationOverlay()).toBeInTheDocument();
  });

  it('toggles back to only what the fragment asked for', () => {
    renderWithFragment('#metrics=latency');
    fireEvent.keyDown(window, { key: 'm' });
    fireEvent.keyDown(window, { key: 'm' });
    expect(latencyOverlay()).toBeInTheDocument();
    expect(translationOverlay()).not.toBeInTheDocument();
  });

  it('toggles back off on a second press', () => {
    renderWithFragment('#metrics=latency');
    fireEvent.keyDown(window, { key: 'm' });
    expect(latencyOverlay()).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'm' });
    expect(latencyOverlay()).toBeInTheDocument();
  });

  it('accepts a shifted "M"', () => {
    renderWithFragment('');
    fireEvent.keyDown(window, { key: 'M', shiftKey: true });
    expect(latencyOverlay()).toBeInTheDocument();
  });

  it('ignores "m" typed into a text field', () => {
    renderWithFragment('');
    fireEvent.keyDown(screen.getByLabelText('join code'), { key: 'm' });
    expect(latencyOverlay()).not.toBeInTheDocument();
  });

  it('ignores "m" with a modifier held', () => {
    renderWithFragment('');
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'm', metaKey: true });
    fireEvent.keyDown(window, { key: 'm', altKey: true });
    expect(latencyOverlay()).not.toBeInTheDocument();
  });

  it('ignores an event another handler already claimed', () => {
    renderWithFragment('');
    const claimed = new KeyboardEvent('keydown', {
      key: 'm',
      bubbles: true,
      cancelable: true,
    });
    claimed.preventDefault();
    fireEvent(window, claimed);
    expect(latencyOverlay()).not.toBeInTheDocument();
  });

  it('ignores key repeat while "m" is held down', () => {
    renderWithFragment('');
    fireEvent.keyDown(window, { key: 'm' });
    fireEvent.keyDown(window, { key: 'm', repeat: true });
    expect(latencyOverlay()).toBeInTheDocument();
  });

  it('keeps a toggle after the fragment is stripped from the URL', () => {
    renderWithFragment('#metrics=latency');
    window.location.hash = '';
    fireEvent.keyDown(window, { key: 'm' });
    expect(latencyOverlay()).not.toBeInTheDocument();
  });
});
