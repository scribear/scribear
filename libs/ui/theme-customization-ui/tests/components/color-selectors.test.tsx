import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AccentColorSelector } from '#src/components/color-controls/accent-color-selector.js';
import { BackgroundColorSelector } from '#src/components/color-controls/background-color-selector.js';
import { TranscriptionColorSelector } from '#src/components/color-controls/transcription-color-selector.js';

import { axeViolations } from '../a11y.js';

describe('color selectors', (it) => {
  it('name each input to match its visible label (no 2.5.3 mismatch)', () => {
    render(
      <>
        <BackgroundColorSelector
          backgroundColor="#000000"
          setBackgroundColor={vi.fn()}
        />
        <AccentColorSelector accentColor="#8b0000" setAccentColor={vi.fn()} />
        <TranscriptionColorSelector
          transcriptionColor="#ffff00"
          setTranscriptionColor={vi.fn()}
        />
      </>,
    );

    expect(
      screen.getByRole('textbox', { name: 'Background Color' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Accent Color' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Transcription Color' }),
    ).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <BackgroundColorSelector
        backgroundColor="#000000"
        setBackgroundColor={vi.fn()}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
