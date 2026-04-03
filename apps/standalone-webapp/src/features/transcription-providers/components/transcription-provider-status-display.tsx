import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { selectTargetProviderId } from '#src/features/transcription-providers/stores/provider-preferences-slice';
import { useAppSelector } from '#src/store/use-redux';

import {
  getProviderDisplayName,
  getProviderStatusIcon,
} from '../services/providers/provider-component-registry';

/**
 * Displays the active transcription provider's status icon and display name.
 * Shows "No Provider" when no provider is selected.
 */
export const TranscriptionProviderStatusDisplay = () => {
  const targetProviderId = useAppSelector(selectTargetProviderId);

  const StatusIcon = targetProviderId
    ? getProviderStatusIcon(targetProviderId)
    : null;

  return (
    <Stack direction="row" alignItems="center">
      {/* getProviderStatusIcon returns a stable reference from the module-level registry, not a new component. */}
      {/* eslint-disable-next-line react-hooks/static-components */}
      {StatusIcon ? <StatusIcon /> : null}
      <Typography variant="h6">
        {targetProviderId
          ? getProviderDisplayName(targetProviderId)
          : 'No Provider'}
      </Typography>
    </Stack>
  );
};
