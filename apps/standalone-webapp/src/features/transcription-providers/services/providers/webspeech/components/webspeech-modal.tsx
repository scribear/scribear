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
import { WebspeechStatus } from '../types/webspeech-status';

/**
 * Displays contextual status modals for the Web Speech provider. Shows a
 * spinner while activating, an informational dialog when the browser is
 * unsupported, and a cancel/configure dialog on error.
 */
export const WebspeechModal = () => {
  const dispatch = useAppDispatch();

  const displayName = getProviderDisplayName(ProviderId.WEBSPEECH);
  const webspeechStatus = useAppSelector((state) =>
    selectProviderStatus(state, ProviderId.WEBSPEECH),
  );

  const cancelModal = () => {
    dispatch(setPreferredProviderId(null));
  };

  const configure = () => {
    dispatch(openConfigMenu(ProviderId.WEBSPEECH));
  };

  const activating = (
    <CancelableInfoModal
      isOpen={webspeechStatus === WebspeechStatus.ACTIVATING}
      message={`Initializing ${displayName}.`}
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
      message={`Your browser does not support ${displayName}.`}
      onCancel={cancelModal}
    />
  );

  const error = (
    <ChoiceModal
      isOpen={webspeechStatus === WebspeechStatus.ERROR}
      message={`${displayName} encountered an unexpected error. Is ${displayName} configured correctly?`}
      rightAction="Edit Configuration"
      onRightAction={configure}
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
