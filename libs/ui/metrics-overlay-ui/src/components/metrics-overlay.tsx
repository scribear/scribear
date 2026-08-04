import type { ReactNode } from 'react';

import Stack from '@mui/material/Stack';

/**
 * Props for {@link MetricsOverlay}.
 */
export interface MetricsOverlayProps {
  // The metric cards to show, in the order they should stack.
  children?: ReactNode;
}

/**
 * Diagnostic metric cards, stacked centered along the top of the viewport.
 *
 * Centered rather than tucked into a corner because the top right is where the
 * header controls live; the cards stack downwards so a second overlay does not
 * land on the first.
 *
 * Click-through: these are read, never operated, and must not swallow a tap
 * meant for the captions underneath.
 */
export const MetricsOverlay = ({ children }: MetricsOverlayProps) => (
  <Stack
    spacing={0.5}
    sx={{
      position: 'fixed',
      top: 8,
      left: '50%',
      transform: 'translateX(-50%)',
      alignItems: 'center',
      pointerEvents: 'none',
      zIndex: (theme) => theme.zIndex.tooltip,
    }}
  >
    {children}
  </Stack>
);
