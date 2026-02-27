import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';

import { CancelableInfoModal } from '#src/components/ui/cancelable-info-modal';
import { ChoiceModal } from '#src/components/ui/choice-modal';
import { getProviderDisplayName } from '#src/features/transcription-providers/services/providers/provider-component-registry';
import { setPreferredProviderId } from '#src/features/transcription-providers/stores/provider-preferences-slice';
import { selectProviderStatus } from '#src/features/transcription-providers/stores/provider-status-slice';
import { useAppDispatch, useAppSelector } from '#src/stores/use-redux';

import { ProviderId } from '../../provider-registry';
import { StreamtextStatus } from '../types/streamtext-status';

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

  const connecting = (
    <CancelableInfoModal
      isOpen={streamtextStatus === StreamtextStatus.CONNECTING}
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
      isOpen={streamtextStatus === StreamtextStatus.DISCONNECTED}
      message={`Disconnected from ${displayName}`}
      rightAction="Retry"
      onRightAction={retryActivation}
      onCancel={cancelModal}
    />
  );

  const error = (
    <ChoiceModal
      isOpen={streamtextStatus === StreamtextStatus.ERROR}
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
