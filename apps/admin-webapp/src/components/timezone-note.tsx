import AccessTimeIcon from '@mui/icons-material/AccessTime';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { browserTimeZone } from '#src/lib/timezone';

interface TimezoneNoteProps {
  /**
   * The zone the page's timestamps are rendered in. Omit on pages that show
   * deployment-wide times (audit entries, health checks, device last-seen),
   * which have no room to belong to and are shown in the browser's zone.
   */
  timezone?: string | undefined;
  /** What the zone belongs to, used in the copy. Defaults to "room". */
  ownerLabel?: string | undefined;
}

/**
 * States which timezone the timestamps on this page are printed in.
 *
 * Read-only admin pages are easy to misread: a schedule that says 09:00 means
 * nothing until you know whether that is the room's 09:00 or yours. Any page
 * showing a time renders this note, so the answer is always in the same place
 * and the same words.
 *
 * When a room's zone differs from the operator's own, the two readings of
 * every timestamp on the page diverge — someone in Chicago administering a
 * London room would otherwise silently plan a session six hours off. That
 * case is called out with a red warning triangle rather than folded into the
 * quiet caption, because it is the case where a misread has consequences.
 */
export const TimezoneNote = ({
  timezone,
  ownerLabel = 'room',
}: TimezoneNoteProps) => {
  const browser = browserTimeZone();
  const zone = timezone ?? browser;
  const differs = timezone !== undefined && timezone !== browser;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        mb: 2,
        color: differs ? 'error.main' : 'text.secondary',
      }}
    >
      {differs ? (
        <WarningAmberIcon fontSize="small" color="error" aria-hidden />
      ) : (
        <AccessTimeIcon fontSize="small" aria-hidden />
      )}
      <Typography variant="body2" component="p">
        {differs ? (
          <>
            Times shown in the {ownerLabel}&apos;s timezone,{' '}
            <strong>{zone}</strong> — not your own (<strong>{browser}</strong>).
          </>
        ) : timezone === undefined ? (
          <>
            Times shown in your timezone, <strong>{zone}</strong>.
          </>
        ) : (
          <>
            Times shown in the {ownerLabel}&apos;s timezone,{' '}
            <strong>{zone}</strong>, which matches your own.
          </>
        )}
      </Typography>
    </Box>
  );
};
