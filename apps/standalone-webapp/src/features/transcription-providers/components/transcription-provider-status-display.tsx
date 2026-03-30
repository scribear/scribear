import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { selectTargetProviderId } from '#src/features/transcription-providers/stores/provider-preferences-slice';
import { useAppSelector } from '#src/store/use-redux';

import {
  getProviderDisplayName,
  providerComponentRegistry,
} from '../services/providers/provider-component-registry';
import { ProviderId } from '../services/providers/provider-registry';

/**
 * Displays the active transcription provider's status icon and display name.
 * Shows "No Provider" when no provider is selected.
 */
export const TranscriptionProviderStatusDisplay = () => {
  const targetProviderId = useAppSelector(selectTargetProviderId);

  const icons = Object.fromEntries(
    Object.values(ProviderId).map((id) => {
      const StatusIcon = providerComponentRegistry[id].statusIcon;
      return [id, <StatusIcon key={id} />];
    }),
  );

  return (
    <Stack direction="row" alignItems="center">
      {targetProviderId ? icons[targetProviderId] : null}
      <Typography variant="h6">
        {targetProviderId
          ? getProviderDisplayName(targetProviderId)
          : 'No Provider'}
      </Typography>
    </Stack>
  );
};
