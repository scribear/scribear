import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect } from 'vitest';

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

  it('keeps the dBFS readout from shrinking beside the bar', () => {
    // The bar asks for `width: 100%`, so in the flex row both children compete
    // for space. `minWidth` reads like a floor but is not one on its own: it
    // replaces a flex item's default `min-width: auto`, which is exactly the
    // rule that stops an item shrinking below its own content — so the readout
    // rendered clipped mid-word ("-23.4 dB…") on every session card until
    // `flexShrink: 0` was added.
    //
    // jsdom does no layout, so this asserts the declaration rather than the
    // result; the clipping itself was only visible in a real browser.
    render(
      <AudioMeterBar
        rmsDbfs={-23.4}
        peakDbfs={-12.1}
        status="good"
        label="Audio level for session test"
      />,
    );

    const readout = screen.getByText('-23.4 dBFS');

    expect(getComputedStyle(readout).flexShrink).toBe('0');
    expect(getComputedStyle(readout).whiteSpace).toBe('nowrap');
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

  it('names the window peak in aria-valuetext, since the marker is aria-hidden', () => {
    // The peak marker is a decorative tick; without this the figure would be
    // available to sighted users only. "window peak" is deliberate — the
    // standalone meter's headline "Peak" is a hold-and-decay meter and reads
    // lower on the same audio, so an unqualified "peak" would invite a wrong
    // comparison between the two surfaces.
    render(
      <AudioMeterBar
        rmsDbfs={-23.4}
        peakDbfs={-12.1}
        status="good"
        label="Audio level for session test"
      />,
    );

    const bar = document.querySelector('[role="progressbar"]');

    expect(bar?.getAttribute('aria-valuetext')).toBe(
      '-23.4 dBFS RMS, window peak -12.1 dBFS, level OK',
    );
  });

  it('omits the peak from aria-valuetext when none was published', () => {
    render(
      <AudioMeterBar
        rmsDbfs={-23.4}
        status="good"
        label="Audio level for session test"
      />,
    );

    const bar = document.querySelector('[role="progressbar"]');

    expect(bar?.getAttribute('aria-valuetext')).not.toContain('peak');
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
