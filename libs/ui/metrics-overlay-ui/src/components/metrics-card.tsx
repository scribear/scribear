import type { ReactNode } from 'react';

import { Box, Typography } from '@mui/material';

interface MetricsCardProps {
  /** Names what is being measured; the unit belongs in the corner cell. */
  title: string;
  /** Accessible name for the table inside the card. */
  tableLabel: string;
  /** The table's `thead` and `tbody`. */
  children: ReactNode;
  /** Optional line under the table for counters that are not milliseconds. */
  footer?: ReactNode;
}

/**
 * One dark card in the metrics overlay: a title, a table of figures, and an
 * optional footer of counters. Positioned by the overlay that renders it.
 */
export const MetricsCard = ({
  title,
  tableLabel,
  children,
  footer,
}: MetricsCardProps) => (
  <Box
    sx={{
      px: 0.5,
      py: 0.5,
      borderRadius: 1,
      bgcolor: 'rgba(0, 0, 0, 0.6)',
      color: 'common.white',
    }}
  >
    <Typography
      variant="caption"
      component="div"
      sx={{ px: 0.75, fontWeight: 600, opacity: 0.8 }}
    >
      {title}
    </Typography>
    <Typography
      variant="caption"
      component="table"
      aria-label={tableLabel}
      sx={{ borderCollapse: 'collapse' }}
    >
      {children}
    </Typography>
    {footer !== undefined && (
      <Typography
        variant="caption"
        component="div"
        sx={{ px: 0.75, opacity: 0.8, fontVariantNumeric: 'tabular-nums' }}
      >
        {footer}
      </Typography>
    )}
  </Box>
);
