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

  // getProviderStatusIcon returns a stable reference from the module-level registry, not a new component.
  /* eslint-disable @eslint-react/static-components */
  const StatusIcon = targetProviderId
    ? getProviderStatusIcon(targetProviderId)
    : null;
  /* eslint-enable @eslint-react/static-components */

  return (
    <Stack direction="row" alignItems="center">
      {/* getProviderStatusIcon returns a stable reference from the module-level registry, not a new component. */}
      {/* eslint-disable-next-line react-hooks/static-components, @eslint-react/static-components */}
      {StatusIcon ? <StatusIcon /> : null}
      {/* Provider name is a status label in the header, not a section heading. */}
      <Typography variant="h6" component="span">
        {targetProviderId
          ? getProviderDisplayName(targetProviderId)
          : 'No Provider'}
      </Typography>
    </Stack>
  );
};
