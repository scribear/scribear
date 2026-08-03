import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import NotInterestedIcon from '@mui/icons-material/NotInterested';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';

import { getProviderDisplayName } from '#src/features/transcription-providers/services/providers/provider-component-registry';
import { selectProviderStatus } from '#src/features/transcription-providers/stores/provider-status-slice';
import { useAppSelector } from '#src/store/use-redux';

import { ProviderId } from '../../provider-registry';
import { StreamtextStatus } from '../types/streamtext-status';

/**
 * Displays an icon and tooltip reflecting the current StreamText provider
 * status. The icon updates automatically as the provider state changes.
 */
export const StreamtextStatusIcon = () => {
  const displayName = getProviderDisplayName(ProviderId.STREAMTEXT);
  const streamtextStatus = useAppSelector((state) =>
    selectProviderStatus(state, ProviderId.STREAMTEXT),
  );

  let icon = <NotInterestedIcon />;
  let tooltip = `${displayName} is inactive`;

  if (streamtextStatus === StreamtextStatus.DISCONNECTED) {
    icon = <LinkOffIcon />;
    tooltip = `${displayName} disconnected`;
  } else if (streamtextStatus === StreamtextStatus.CONNECTING) {
    icon = <HourglassTopIcon />;
    tooltip = `${displayName} connecting`;
  } else if (streamtextStatus === StreamtextStatus.ACTIVE) {
    icon = <CheckCircleOutlinedIcon />;
    tooltip = `${displayName} is transcribing`;
  } else if (streamtextStatus === StreamtextStatus.ACTIVE_MUTE) {
    icon = <PauseCircleOutlinedIcon />;
    tooltip = `${displayName} is paused`;
  } else if (streamtextStatus === StreamtextStatus.ERROR) {
    icon = <NotInterestedIcon />;
    tooltip = `${displayName} encountered an unexpected error`;
  }

  return (
    <Tooltip title={tooltip}>
      {/* role="img" + aria-label exposes the status (distinct icon shapes carry
          it visually) to AT, which a tooltip on a non-focusable box does not. */}
      <Stack sx={{ p: 1 }} role="img" aria-label={tooltip}>
        {icon}
      </Stack>
    </Tooltip>
  );
};
