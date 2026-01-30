import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';

import { CancelableInfoModal } from '@/components/ui/cancelable-info-modal';
import { ChoiceModal } from '@/components/ui/choice-modal';
import { getProviderDisplayName } from '@/features/transcription-providers/services/providers/provider-component-registry';
import { setPreferredProviderId } from '@/features/transcription-providers/stores/provider-preferences-slice';
import { selectProviderStatus } from '@/features/transcription-providers/stores/provider-status-slice';
import { useAppDispatch, useAppSelector } from '@/stores/use-redux';

import { ProviderId } from '../../provider-registry';
import { WebspeechStatus } from '../types/webspeech-status';

export const WebspeechModal = () => {
  const dispatch = useAppDispatch();

  const displayName = getProviderDisplayName(ProviderId.WEBSPEECH);
  const webspeechStatus = useAppSelector((state) =>
    selectProviderStatus(state, ProviderId.WEBSPEECH),
  );

  const cancelModal = () => {
    dispatch(setPreferredProviderId(null));
  };

  const retryActivation = () => {
    dispatch(setPreferredProviderId(null));
    dispatch(setPreferredProviderId(ProviderId.WEBSPEECH));
  };

  const activating = (
    <CancelableInfoModal
      isOpen={webspeechStatus === WebspeechStatus.ACTIVATING}
      message={`Connecting to ${displayName}`}
      onCancel={cancelModal}
    >
      <Stack direction="row" justifyContent="space-around">
        <CircularProgress />
      </Stack>
    </CancelableInfoModal>
  );

  const unsupported = (
    <CancelableInfoModal
      isOpen={webspeechStatus === WebspeechStatus.UNSUPPORTED}
      message={`Your browser does not support ${displayName}`}
      onCancel={cancelModal}
    />
  );

  const error = (
    <ChoiceModal
      isOpen={webspeechStatus === WebspeechStatus.ERROR}
      message={`${displayName} encountered an unexpected error`}
      rightAction="Retry"
      onRightAction={retryActivation}
      onCancel={cancelModal}
    />
  );

  return (
    <>
      {activating}
      {unsupported}
      {error}
    </>
  );
};
