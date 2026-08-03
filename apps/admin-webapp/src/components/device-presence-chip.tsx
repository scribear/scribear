import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import type { DevicePresenceFacts } from '#src/lib/device-presence';
import { devicePresenceColor, formatLastSeen } from '#src/lib/device-presence';

interface DevicePresenceChipProps extends DevicePresenceFacts {
  /**
   * Show `lastSeenAt` as plain adjacent text instead of only inside the hover
   * tooltip. Table rows (devices list, room device table) use the compact
   * tooltip form; the device detail page — the deepest page, which must be at
   * least as informative as the list — shows it unconditionally so the fact
   * doesn't depend on a mouse hover to be read.
   */
  showLastSeenText?: boolean;
}

/**
 * A device's presence — online/offline plus `lastSeenAt` — kept visually and
 * semantically distinct from its activation state (Active/Pending). A device
 * can be Active *and* Offline at once (registered and previously connected,
 * currently unplugged); that combination is exactly what an operator standing
 * on the room page needs to be able to see, so this never replaces the
 * activation chip, only sits alongside it.
 *
 * Shared by the devices list, the room detail page's device table, and the
 * device detail page so all three agree on wording, color, and the
 * online/offline cutoff — which is computed server-side (`Device.online`) so
 * every consumer agrees with every other one.
 */
export const DevicePresenceChip = ({
  active,
  online,
  lastSeenAt,
  showLastSeenText = false,
}: DevicePresenceChipProps) => {
  const lastSeenText = formatLastSeen(lastSeenAt);
  const chip = (
    <Chip
      size="small"
      label={online ? 'Online' : 'Offline'}
      color={devicePresenceColor({ active, online })}
      variant="outlined"
    />
  );

  if (showLastSeenText) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {chip}
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {lastSeenText}
        </Typography>
      </Box>
    );
  }

  return <Tooltip title={lastSeenText}>{chip}</Tooltip>;
};
