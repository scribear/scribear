import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import NotInterestedIcon from '@mui/icons-material/NotInterested';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';

import { getProviderDisplayName } from '#src/features/transcription-providers/services/providers/provider-component-registry';
import { selectProviderStatus } from '#src/features/transcription-providers/stores/provider-status-slice';
import { useAppSelector } from '#src/stores/use-redux';

import { ProviderId } from '../../provider-registry';
import { AzureStatus } from '../types/azure-status';

export const AzureStatusIcon = () => {
  const displayName = getProviderDisplayName(ProviderId.AZURE);
  const azureStatus = useAppSelector((state) =>
    selectProviderStatus(state, ProviderId.AZURE),
  );

  let icon = <NotInterestedIcon />;
  let tooltip = `${displayName} is inactive`;

  if (azureStatus === AzureStatus.DISCONNECTED) {
    icon = <LinkOffIcon />;
    tooltip = `${displayName} disconnected`;
  } else if (azureStatus === AzureStatus.CONNECTING) {
    icon = <HourglassTopIcon />;
    tooltip = `${displayName} connecting`;
  } else if (azureStatus === AzureStatus.ACTIVE) {
    icon = <CheckCircleOutlineIcon />;
    tooltip = `${displayName} is transcribing`;
  } else if (azureStatus === AzureStatus.ACTIVE_MUTE) {
    icon = <PauseCircleOutlineIcon />;
    tooltip = `${displayName} is not transcribing, microphone muted`;
  } else if (azureStatus === AzureStatus.ERROR) {
    icon = <NotInterestedIcon />;
    tooltip = `${displayName} encountered an unexpected error`;
  }

  return (
    <Tooltip title={tooltip}>
      <Stack sx={{ p: 1 }}>{icon}</Stack>
    </Tooltip>
  );
};
