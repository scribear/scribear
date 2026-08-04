import { Stack } from '@mui/material';

import { TranslationMetricsBadge } from '#src/features/metrics-overlay/components/translation-metrics-badge';
import { useMetricsOverlay } from '#src/features/metrics-overlay/use-metrics-overlay';
import { LatencyBadge } from '#src/features/session-provider/components/latency-badge';

/**
 * Diagnostic overlays, stacked centered along the top of the viewport.
 *
 * Which ones appear is decided by {@link useMetricsOverlay}: the `#metrics=`
 * fragment on load, toggled by `m`. Centered rather than tucked into a corner
 * because the top right is where the header controls live; the cards stack
 * downwards so a second overlay does not land on the first.
 *
 * Click-through: these are read, never operated, and must not swallow a tap
 * meant for the captions underneath.
 */
export const MetricsOverlay = () => {
  const visibleMetrics = useMetricsOverlay();

  if (visibleMetrics.size === 0) return null;

  return (
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
      {visibleMetrics.has('latency') && <LatencyBadge />}
      {visibleMetrics.has('translation') && <TranslationMetricsBadge />}
    </Stack>
  );
};
