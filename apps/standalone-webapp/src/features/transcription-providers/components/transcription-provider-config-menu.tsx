import { useState } from 'react';

import { ChoiceModal } from '@scribear/core-ui';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { getProviderConfigMenu } from '../services/providers/provider-component-registry';
import { ProviderId } from '../services/providers/provider-registry';
import {
  closeConfigMenu,
  selectConfigMenuProviderId,
} from '../stores/provider-ui-slice';

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

  const closeConfirmPrompt = () => {
    setIsConfirmPromptOpen(false);
  };

  const handleClose = (showConfirmPrompt: boolean) => {
    if (showConfirmPrompt) {
      setIsConfirmPromptOpen(true);
    } else {
      setIsConfirmPromptOpen(false);
      dispatch(closeConfigMenu());
    }
  };

  const confirmPrompt = (
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
  );

  const menus = Object.fromEntries(
    Object.values(ProviderId).map((id) => {
      const ConfigMenu = getProviderConfigMenu(id);
      return [id, <ConfigMenu onClose={handleClose} key={id} />];
    }),
  );

  if (!configMenuProviderId) return null;

  return (
    <>
      {confirmPrompt}
      {menus[configMenuProviderId]}
    </>
  );
};
