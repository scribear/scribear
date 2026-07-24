import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  ActiveSection,
  TranscriptionSection,
} from '@scribear/transcription-content-store';

import { TranscriptionDisplayContainer } from '#src/components/transcription-display-container.js';

import { axeViolations } from '../a11y.js';
import { renderWithProviders } from '../render.js';

const commitedSections: TranscriptionSection[] = [
  { id: 's1', text: 'Hello world.' },
];
const activeSection: ActiveSection = {
  id: 'active',
  sequences: [{ id: 'seq1', text: ['partial ', 'interim'] }],
};

function renderContainer() {
  return renderWithProviders(
    <TranscriptionDisplayContainer
      commitedSections={commitedSections}
      activeSection={activeSection}
      inProgressTranscriptionText=" live"
      wordSpacingEm={0}
      fontSizePx={32}
      lineHeightPx={40}
      getBoundedDisplayPreferences={() => ({
        verticalPositionPx: 0,
        numDisplayLines: 8,
      })}
    />,
  );
}

describe('TranscriptionDisplayContainer', (it) => {
  it('exposes the committed transcript as a labelled polite log region', () => {
    renderContainer();

    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-relevant', 'additions text');
    expect(log).toHaveAttribute('aria-atomic', 'false');
    expect(log).toHaveAccessibleName('Live transcription');
    // Focusable so keyboard + AT users can scroll back through history.
    expect(log).toHaveAttribute('tabindex', '0');

    // Finalized text is present (and will be announced as it's appended).
    expect(screen.getByText('Hello world.')).toBeInTheDocument();
  });

  it('hides the interim/in-progress text from assistive technology', () => {
    const { container } = renderContainer();

    // The interim text lives inside an aria-hidden node so its churn is never
    // announced; it is announced once, later, when it becomes a committed section.
    const hidden = container.querySelector('[aria-hidden="true"]');
    expect(hidden).not.toBeNull();
    expect(hidden?.textContent).toContain('partial');
    expect(hidden?.textContent).toContain('live');
  });

  it('has no axe violations', async () => {
    const { container } = renderContainer();
    expect(await axeViolations(container)).toEqual([]);
  });
});
