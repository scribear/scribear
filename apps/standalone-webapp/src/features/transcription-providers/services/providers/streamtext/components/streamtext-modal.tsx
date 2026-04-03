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
import { StreamtextStatus } from '../types/streamtext-status';

/**
 * Displays contextual status modals for the StreamText provider. Shows a
 * spinner while connecting, a retry/configure dialog when disconnected, and a
 * cancel/configure dialog when an error occurs (e.g. empty event name).
 */
export const StreamtextModal = () => {
  const dispatch = useAppDispatch();

  const displayName = getProviderDisplayName(ProviderId.STREAMTEXT);
  const streamtextStatus = useAppSelector((state) =>
    selectProviderStatus(state, ProviderId.STREAMTEXT),
  );

  const cancelModal = () => {
    dispatch(setPreferredProviderId(null));
  };

  const retryActivation = () => {
    // Retry action forces provider reactivation immediately; auto-retry still runs in background.
    dispatch(setPreferredProviderId(null));
    dispatch(setPreferredProviderId(ProviderId.STREAMTEXT));
  };

  const configure = () => {
    dispatch(openConfigMenu(ProviderId.STREAMTEXT));
  };

  const connecting = (
    <CancelableInfoModal
      isOpen={streamtextStatus === StreamtextStatus.CONNECTING}
      message={`Connecting to ${displayName}.`}
      onCancel={cancelModal}
    >
      <Stack direction="row" justifyContent="space-around">
        <CircularProgress />
      </Stack>
    </CancelableInfoModal>
  );

  const disconnected = (
    <ChoiceModal
      isOpen={streamtextStatus === StreamtextStatus.DISCONNECTED}
      message={`Disconnected from ${displayName}.`}
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
      isOpen={streamtextStatus === StreamtextStatus.ERROR}
      message={`${displayName} encountered an unexpected error. Is ${displayName} configured correctly?`}
      rightAction="Edit Configuration"
      onRightAction={configure}
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
