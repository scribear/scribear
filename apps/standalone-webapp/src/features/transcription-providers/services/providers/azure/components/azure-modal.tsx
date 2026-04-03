import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';

import { CancelableInfoModal } from '@scribear/core-ui';
import { ChoiceModal } from '@scribear/core-ui';

import { getProviderDisplayName } from '#src/features/transcription-providers/services/providers/provider-component-registry';
import { setPreferredProviderId } from '#src/features/transcription-providers/stores/provider-preferences-slice';
import { selectProviderStatus } from '#src/features/transcription-providers/stores/provider-status-slice';
import { openConfigMenu } from '#src/features/transcription-providers/stores/provider-ui-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { ProviderId } from '../../provider-registry';
import { AzureStatus } from '../types/azure-status';

/**
 * Displays contextual status modals for the Azure provider. Shows a spinner
 * while connecting, a retry/configure dialog when disconnected, and an error
 * dialog when an unexpected error occurs.
 */
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

  const configure = () => {
    dispatch(openConfigMenu(ProviderId.AZURE));
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
      leftAction="Configure"
      leftColor="info"
      onLeftAction={configure}
      rightAction="Retry"
      onRightAction={retryActivation}
      onCancel={cancelModal}
    />
  );

  const error = (
    <ChoiceModal
      isOpen={azureStatus === AzureStatus.ERROR}
      message={`${displayName} encountered an unexpected error`}
      leftAction="Configure"
      leftColor="info"
      onLeftAction={configure}
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
