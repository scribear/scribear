import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';

import { CancelableInfoModal } from '#src/components/ui/cancelable-info-modal';
import { ChoiceModal } from '#src/components/ui/choice-modal';
import { getProviderDisplayName } from '#src/features/transcription-providers/services/providers/provider-component-registry';
import { setPreferredProviderId } from '#src/features/transcription-providers/stores/provider-preferences-slice';
import { selectProviderStatus } from '#src/features/transcription-providers/stores/provider-status-slice';
import { useAppDispatch, useAppSelector } from '#src/stores/use-redux';

import { ProviderId } from '../../provider-registry';
import { AzureStatus } from '../types/azure-status';

export const AzureModal = () => {
  const dispatch = useAppDispatch();

  const displayName = getProviderDisplayName(ProviderId.AZURE);
  const azureStatus = useAppSelector((state) =>
    selectProviderStatus(state, ProviderId.AZURE),
  );

  const cancelModal = () => {
    dispatch(setPreferredProviderId(null));
  };

  const retryActivation = () => {
    dispatch(setPreferredProviderId(null));
    dispatch(setPreferredProviderId(ProviderId.AZURE));
  };

  const connecting = (
    <CancelableInfoModal
      isOpen={azureStatus === AzureStatus.CONNECTING}
      message={`Connecting to ${displayName}`}
      onCancel={cancelModal}
    >
      <Stack direction="row" justifyContent="space-around">
        <CircularProgress />
      </Stack>
    </CancelableInfoModal>
  );

  const disconnected = (
    <ChoiceModal
      isOpen={azureStatus === AzureStatus.DISCONNECTED}
      message={`Disconnected from ${displayName}`}
      rightAction="Retry"
      onRightAction={retryActivation}
      onCancel={cancelModal}
    />
  );

  const error = (
    <ChoiceModal
      isOpen={azureStatus === AzureStatus.DISCONNECTED}
      message={`${displayName} encountered an unexpected error`}
      rightAction="Retry"
      onRightAction={retryActivation}
      onCancel={cancelModal}
    />
  );

  return (
    <>
      {connecting}
      {disconnected}
      {error}
    </>
  );
};
