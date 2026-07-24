import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { VisualizerPanel } from '#src/components/visualizer-panel.js';

import { axeViolations } from '../a11y.js';

function renderPanel(overrides = {}) {
  const props = {
    analyserNode: null,
    frequencyEnabled: false,
    timeSeriesEnabled: false,
    melCepstrumEnabled: false,
    targetX: 100,
    targetY: 100,
    targetWidth: 300,
    targetHeight: 200,
    onPositionChange: vi.fn(),
    onSizeChange: vi.fn(),
    ...overrides,
  };
  render(<VisualizerPanel {...props} />);
  return props;
}

describe('VisualizerPanel handles', (it) => {
  it('moves via arrow keys on the named drag handle', () => {
    const { onPositionChange } = renderPanel();

    const move = screen.getByRole('button', {
      name: 'Move visualizer (use arrow keys)',
    });
    fireEvent.keyDown(move, { key: 'ArrowRight' });
    expect(onPositionChange).toHaveBeenCalledWith(110, 100);
    fireEvent.keyDown(move, { key: 'ArrowUp' });
    expect(onPositionChange).toHaveBeenCalledWith(100, 90);
  });

  it('resizes via arrow keys on the named resize handle', () => {
    const { onSizeChange } = renderPanel();

    const resize = screen.getByRole('button', {
      name: 'Resize visualizer (use arrow keys)',
    });
    fireEvent.keyDown(resize, { key: 'ArrowDown' });
    expect(onSizeChange).toHaveBeenCalledWith(300, 210);
    fireEvent.keyDown(resize, { key: 'ArrowLeft' });
    expect(onSizeChange).toHaveBeenCalledWith(290, 200);
  });

  it('has no axe violations', async () => {
    renderPanel();
    expect(await axeViolations()).toEqual([]);
  });
});
