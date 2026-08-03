import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

import type { Session } from '@scribear/session-manager-schema';

import { sessionTypeColor } from '#src/lib/session-rules';

import { computeBlockPosition } from './session-calendar-grid.utils';

export interface CalendarColumn {
  key: string; // room uid (multi-room mode) or ISO date string (week mode)
  label: string; // room name, or "Mon 3/2"
}

export interface SessionCalendarGridProps {
  columns: CalendarColumn[];
  sessions: Session[];
  getColumnKeyForSession: (session: Session) => string;
  dayStartHour?: number; // default 7
  dayEndHour?: number; // default 22
  onSessionClick: (session: Session) => void;
  showUuids: boolean;
}

/**
 * Shared grid renderer for both the single-room week/day view and the
 * multi-room day overview, parameterized by columns. Hour gridlines, a
 * current-time indicator, and overlap-within-a-column layout are reasonable
 * follow-ups, not required for a correct first version: overlapping
 * non-canceled sessions in one room cannot happen (DB exclusion constraint),
 * and a canceled+active pair rendering stacked/overlapping is cosmetic, not
 * a correctness issue.
 */
export const SessionCalendarGrid = ({
  columns,
  sessions,
  getColumnKeyForSession,
  dayStartHour = 7,
  dayEndHour = 22,
  onSessionClick,
  showUuids,
}: SessionCalendarGridProps) => {
  const byColumn = new Map<string, Session[]>(columns.map((c) => [c.key, []]));
  for (const s of sessions) {
    const key = getColumnKeyForSession(s);
    byColumn.get(key)?.push(s);
  }

  return (
    <Box
      sx={{
        display: 'flex',
        overflowX: 'auto',
        gap: 1,
        // Keyboard-operability for the horizontal scroll (SC 2.1.1): a
        // focusable region is arrow/PageUp/PageDown/Home/End-scrollable even
        // though the browser's native scroll keys act on the focused
        // element. A plain MUI `Box` has no focus indicator of its own, so a
        // visible one is required too (SC 2.4.7) — same reasoning and same
        // `:focus-visible` outline pattern as the live-caption scroll region
        // (transcription-display-container.tsx) and the visualizer resize
        // handles (visualizer-panel.tsx).
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: '2px',
        },
      }}
      tabIndex={0}
      role="region"
      aria-label="Session calendar"
    >
      {columns.map((col) => (
        <Paper
          key={col.key}
          variant="outlined"
          sx={{ flex: '0 0 220px', position: 'relative', height: 600 }}
        >
          {/* `component="p"` is load-bearing: MUI maps the `subtitle2`
              *variant* to an `<h6>` element regardless of what the text is,
              so without this a column label - a room name or an ISO date -
              would enter the document outline at level 6, under a page whose
              last heading is an `h2`. That skips four levels and fails axe's
              heading-order rule. These are labels for the columns beside
              them, not sections of the page, so the right fix is to keep the
              type scale and drop the heading element. */}
          <Typography
            variant="subtitle2"
            component="p"
            sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }}
          >
            {col.label}
          </Typography>
          <Box sx={{ position: 'relative', height: 'calc(100% - 40px)' }}>
            {(byColumn.get(col.key) ?? []).map((session) => {
              const pos = computeBlockPosition(
                session,
                dayStartHour,
                dayEndHour,
              );
              if (!pos) return null;
              const canceled = session.canceledAt !== null;
              return (
                <Box
                  key={session.uid}
                  onClick={() => {
                    onSessionClick(session);
                  }}
                  sx={{
                    position: 'absolute',
                    top: `${String(pos.topPct)}%`,
                    height: `${String(pos.heightPct)}%`,
                    left: 4,
                    right: 4,
                    bgcolor: `${sessionTypeColor(session.type)}.light`,
                    opacity: canceled ? 0.4 : 1,
                    textDecoration: canceled ? 'line-through' : 'none',
                    borderRadius: 1,
                    p: 0.5,
                    cursor: 'pointer',
                    overflow: 'hidden',
                    fontSize: '0.75rem',
                  }}
                >
                  {session.name}
                  {showUuids && (
                    <Typography variant="caption" sx={{ display: 'block' }}>
                      {session.uid}
                    </Typography>
                  )}
                  {canceled && (
                    <Typography variant="caption" sx={{ display: 'block' }}>
                      Canceled
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        </Paper>
      ))}
    </Box>
  );
};
