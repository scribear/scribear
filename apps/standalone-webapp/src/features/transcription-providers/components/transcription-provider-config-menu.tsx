import { Suspense, useState } from 'react';

import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';

import { ChoiceModal } from '@scribear/core-ui';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import {
  getProviderConfigMenu,
  getProviderDisplayName,
} from '../services/providers/provider-component-registry';
import type { ProviderId } from '../services/providers/provider-registry';
import {
  closeConfigMenu,
  selectConfigMenuProviderId,
} from '../stores/provider-ui-slice';
import { ProviderConfigContainer } from './provider-config-container';

/**
 * Renders the configuration menu for whichever provider is currently set in
 * the `providerUI` Redux slice. Includes an unsaved-changes confirmation modal
 * that is shown when the user tries to close the menu with pending edits.
 * Renders nothing when no config menu is open.
 */
export const TranscriptionProviderConfigMenu = () => {
  const dispatch = useAppDispatch();
  const configMenuProviderId = useAppSelector(selectConfigMenuProviderId);
  const [isConfirmPromptOpen, setIsConfirmPromptOpen] = useState(false);
  // Track which provider the dirty state belongs to so it resets automatically
  // when a different provider's menu is opened, without needing an effect.
  const [dirtyForProviderId, setDirtyForProviderId] = useState<
    ProviderId | null | undefined
  >(null);
  const isFormDirty = dirtyForProviderId === configMenuProviderId;

  const closeConfirmPrompt = () => {
    setIsConfirmPromptOpen(false);
  };

  const handleDirtyChange = (isDirty: boolean) => {
    setDirtyForProviderId(isDirty ? configMenuProviderId : null);
  };

  const handleClose = (showConfirmPrompt: boolean) => {
    if (showConfirmPrompt) {
      setIsConfirmPromptOpen(true);
    } else {
      setIsConfirmPromptOpen(false);
      setDirtyForProviderId(null);
      dispatch(closeConfigMenu());
    }
  };

  if (!configMenuProviderId) return null;

  const ConfigMenu = getProviderConfigMenu(configMenuProviderId);

  return (
    <>
      <ChoiceModal
        isOpen={isConfirmPromptOpen}
        message="You have unsaved changes. If you close the menu, your changes will be lost. Are you sure you want to close this menu?"
        onCancel={closeConfirmPrompt}
        leftColor="info"
        rightColor="error"
        rightAction="Close Menu"
        onRightAction={() => {
          handleClose(false);
        }}
      />
      <ProviderConfigContainer
        displayName={getProviderDisplayName(configMenuProviderId)}
        onClose={() => {
          handleClose(isFormDirty);
        }}
      >
        <Suspense
          fallback={
            <Stack direction="row" justifyContent="space-around" py={4}>
              <CircularProgress />
            </Stack>
          }
        >
          {/* getProviderConfigMenu returns a stable reference from the module-level registry, not a new component. */}
          {/* eslint-disable-next-line react-hooks/static-components */}
          <ConfigMenu onClose={handleClose} onDirtyChange={handleDirtyChange} />
        </Suspense>
      </ProviderConfigContainer>
    </>
  );
};
