import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PresetThemeSelector } from '#src/components/preset-theme-selector.js';

describe('PresetThemeSelector', (it) => {
  it('names the trigger and each swatch (not just "T")', () => {
    render(<PresetThemeSelector applyPresetTheme={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'View Preset Themes' });
    fireEvent.click(trigger);

    // Swatches expose the theme name, not the decorative "T".
    expect(
      screen.getByRole('button', { name: 'Default' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sky Blue' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'T' })).not.toBeInTheDocument();
  });

  it('applies a preset when its swatch is clicked', () => {
    const applyPresetTheme = vi.fn();
    render(<PresetThemeSelector applyPresetTheme={applyPresetTheme} />);

    fireEvent.click(screen.getByRole('button', { name: 'View Preset Themes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    expect(applyPresetTheme).toHaveBeenCalledOnce();
  });
});
