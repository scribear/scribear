import { useState } from 'react';

import { ChoiceModal } from '#src/components/ui/choice-modal';

import { getProviderConfigMenu } from '../services/providers/provider-component-registry';
import { ProviderId } from '../services/providers/provider-registry';

interface TranscriptionProviderConfigMenuProps {
  providerId: ProviderId;
  onClose: () => void;
}

export const TranscriptionProviderConfigMenu = ({
  providerId,
  onClose,
}: TranscriptionProviderConfigMenuProps) => {
  const [isConfirmPromptOpen, setIsConfirmPromptOpen] = useState(false);

  const closeConfirmPrompt = () => {
    setIsConfirmPromptOpen(false);
  };

  const closeMenu = (showConfirmPrompt: boolean) => {
    if (showConfirmPrompt) {
      setIsConfirmPromptOpen(true);
    } else {
      setIsConfirmPromptOpen(false);
      onClose();
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
        closeMenu(false);
      }}
    />
  );

  const menus = Object.fromEntries(
    Object.values(ProviderId).map((id) => {
      const ConfigMenu = getProviderConfigMenu(id);
      return [id, <ConfigMenu onClose={closeMenu} key={id} />];
    }),
  );

  return (
    <>
      {confirmPrompt}
      {menus[providerId]}
    </>
  );
};
