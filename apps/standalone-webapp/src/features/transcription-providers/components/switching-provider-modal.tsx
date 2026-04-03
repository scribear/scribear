import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';

import { CancelableInfoModal } from '@scribear/core-ui';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { setPreferredProviderId } from '../stores/provider-preferences-slice';
import { selectIsLoadingProvider } from '../stores/provider-ui-slice';

/**
 * Displays a non-cancellable spinner modal while the provider service is
 * lazy-loading a provider module.
 */
export const SwitchingProviderModal = () => {
  const dispatch = useAppDispatch();
  const isLoadingProvider = useAppSelector(selectIsLoadingProvider);

  return (
    <CancelableInfoModal
      isOpen={isLoadingProvider}
      message="Switching transcription provider."
      onCancel={() => {
        dispatch(setPreferredProviderId(null));
      }}
    >
      <Stack direction="row" justifyContent="space-around">
        <CircularProgress />
      </Stack>
    </CancelableInfoModal>
  );
};
