import { describe, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { AudioMeterBar } from '#src/features/dashboard/audio-meter-bar';

describe('AudioMeterBar', (it) => {
  it('has no a11y violations with a signal', async () => {
    const { container } = render(
      <AudioMeterBar
        rmsDbfs={-23.4}
        peakDbfs={-12.1}
        status="good"
        label="Audio level for session test"
      />,
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('has no a11y violations with no signal', async () => {
    const { container } = render(
      <AudioMeterBar
        rmsDbfs={null}
        status="unknown"
        label="Audio level for session test"
      />,
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('renders the numeric dBFS as visible text beside the bar', () => {
    render(
      <AudioMeterBar
        rmsDbfs={-23.4}
        status="good"
        label="Audio level for session test"
      />,
    );

    expect(document.body).toHaveTextContent('-23.4 dBFS');
  });

  it('renders an em-dash when there is no signal', () => {
    render(
      <AudioMeterBar
        rmsDbfs={null}
        status="unknown"
        label="Audio level for session test"
      />,
    );

    expect(document.body).toHaveTextContent('— dBFS');
  });

  it('exposes aria-valuetext with the dB figure and zone in words', () => {
    render(
      <AudioMeterBar
        rmsDbfs={-23.4}
        status="good"
        label="Audio level for session test"
      />,
    );

    const bar = document.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-valuetext')).toBe(
      '-23.4 dBFS RMS, level OK',
    );
  });
});
