import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ToggleMicrophoneButton } from '#src/components/toggle-microphone-button.js';

import { axeViolations } from '../a11y.js';

describe('ToggleMicrophoneButton', (it) => {
  it('is a named toggle whose pressed state reflects the mic', () => {
    const { rerender } = render(
      <ToggleMicrophoneButton
        isMicrophoneActive={false}
        activate={vi.fn()}
        deactivate={vi.fn()}
      />,
    );

    const off = screen.getByRole('button', { name: 'Unmute Microphone' });
    expect(off).toHaveAttribute('aria-pressed', 'false');

    rerender(
      <ToggleMicrophoneButton
        isMicrophoneActive
        activate={vi.fn()}
        deactivate={vi.fn()}
      />,
    );
    const on = screen.getByRole('button', { name: 'Mute Microphone' });
    expect(on).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls activate/deactivate on click', () => {
    const activate = vi.fn();
    const deactivate = vi.fn();
    const { rerender } = render(
      <ToggleMicrophoneButton
        isMicrophoneActive={false}
        activate={activate}
        deactivate={deactivate}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(activate).toHaveBeenCalledOnce();

    rerender(
      <ToggleMicrophoneButton
        isMicrophoneActive
        activate={activate}
        deactivate={deactivate}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it('has no axe violations', async () => {
    render(
      <ToggleMicrophoneButton
        isMicrophoneActive={false}
        activate={vi.fn()}
        deactivate={vi.fn()}
      />,
    );
    expect(await axeViolations()).toEqual([]);
  });
});
