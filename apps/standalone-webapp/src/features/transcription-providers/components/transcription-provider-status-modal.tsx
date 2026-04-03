import { Suspense } from 'react';

import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';

import { CancelableInfoModal } from '@scribear/core-ui';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import {
  getProviderDisplayName,
  getProviderStatusModal,
} from '../services/providers/provider-component-registry';
import {
  selectTargetProviderId,
  setPreferredProviderId,
} from '../stores/provider-preferences-slice';

/**
 * Renders the status modal for the currently selected transcription provider.
 * Renders nothing when no provider is selected.
 */
export const TranscriptionProviderStatusModal = () => {
  const dispatch = useAppDispatch();
  const targetProviderId = useAppSelector(selectTargetProviderId);

  if (targetProviderId === null) return null;

  const StatusModal = getProviderStatusModal(targetProviderId);

  const loadingFallback = (
    <CancelableInfoModal
      isOpen
      message={`Loading ${getProviderDisplayName(targetProviderId)}...`}
      onCancel={() => dispatch(setPreferredProviderId(null))}
    >
      <Stack direction="row" justifyContent="space-around">
        <CircularProgress />
      </Stack>
    </CancelableInfoModal>
  );

  return (
    <Suspense fallback={loadingFallback}>
      {/* getProviderStatusModal returns a stable reference from the module-level registry, not a new component. */}
      {/* eslint-disable-next-line react-hooks/static-components */}
      <StatusModal />
    </Suspense>
  );
};
