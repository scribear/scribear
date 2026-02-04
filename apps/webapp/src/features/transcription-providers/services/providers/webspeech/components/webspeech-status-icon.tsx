import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import NotInterestedIcon from '@mui/icons-material/NotInterested';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';

import { getProviderDisplayName } from '@/features/transcription-providers/services/providers/provider-component-registry';
import { selectProviderStatus } from '@/features/transcription-providers/stores/provider-status-slice';
import { useAppSelector } from '@/stores/use-redux';

import { ProviderId } from '../../provider-registry';
import { WebspeechStatus } from '../types/webspeech-status';

export const WebspeechStatusIcon = () => {
  const displayName = getProviderDisplayName(ProviderId.WEBSPEECH);
  const webspeechStatus = useAppSelector((state) =>
    selectProviderStatus(state, ProviderId.WEBSPEECH),
  );

  let icon = <NotInterestedIcon />;
  let tooltip = `${displayName} is inactive`;

  if (webspeechStatus === WebspeechStatus.ACTIVATING) {
    icon = <HourglassTopIcon />;
    tooltip = `${displayName} is starting`;
  } else if (webspeechStatus === WebspeechStatus.ACTIVE) {
    icon = <CheckCircleOutlineIcon />;
    tooltip = `${displayName} is transcribing`;
  } else if (webspeechStatus === WebspeechStatus.ACTIVE_MUTE) {
    icon = <PauseCircleOutlineIcon />;
    tooltip = `${displayName} is not transcribing, microphone muted`;
  } else if (webspeechStatus === WebspeechStatus.UNSUPPORTED) {
    icon = <NotInterestedIcon />;
    tooltip = `${displayName} is not supported`;
  } else if (webspeechStatus === WebspeechStatus.ERROR) {
    icon = <NotInterestedIcon />;
    tooltip = `${displayName} encountered an unexpected error`;
  }

  return (
    <Tooltip title={tooltip}>
      <Stack sx={{ p: 1 }}>{icon}</Stack>
    </Tooltip>
  );
};
