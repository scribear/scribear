import { useAppSelector } from '#src/store/use-redux';

import { getProviderStatusModal } from '../services/providers/provider-component-registry';
import { ProviderId } from '../services/providers/provider-registry';
import { selectTargetProviderId } from '../stores/provider-preferences-slice';

/**
 * Renders the status modal for the currently selected transcription provider.
 * Renders nothing when no provider is selected.
 */
export const TranscriptionProviderStatusModal = () => {
  const targetProviderId = useAppSelector(selectTargetProviderId);

  const modals = Object.fromEntries(
    Object.values(ProviderId).map((id) => {
      const StatusModal = getProviderStatusModal(id);
      return [id, <StatusModal key={id} />];
    }),
  );

  if (targetProviderId === null) return null;
  return modals[targetProviderId];
};
