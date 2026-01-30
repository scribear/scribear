import type React from 'react';

import { AzureConfigMenu } from './azure/components/azure-config-menu';
import { AzureModal } from './azure/components/azure-modal';
import { AzureStatusIcon } from './azure/components/azure-status-icon';
import { AZURE_DISPLAY_NAME } from './azure/config/azure-config';
import { ProviderId } from './provider-registry';
import { WebspeechConfigMenu } from './webspeech/components/webspeech-config-menu';
import { WebspeechModal } from './webspeech/components/webspeech-modal';
import { WebspeechStatusIcon } from './webspeech/components/webspeech-status-icon';
import { WEBSPEECH_DISPLAY_NAME } from './webspeech/config/webspeech-config';

export interface ProviderConfigMenuProps {
  onClose: (showConfirmPrompt: boolean) => void;
}

type ProviderComponentRegistry = Record<
  ProviderId,
  {
    displayName: string;
    statusIcon: () => React.ReactNode;
    statusModal: () => React.ReactNode;
    configMenu: (props: ProviderConfigMenuProps) => React.ReactNode;
  }
>;

export const providerComponentRegistry: ProviderComponentRegistry = {
  [ProviderId.WEBSPEECH]: {
    displayName: WEBSPEECH_DISPLAY_NAME,
    statusIcon: WebspeechStatusIcon,
    statusModal: WebspeechModal,
    configMenu: WebspeechConfigMenu,
  },
  [ProviderId.AZURE]: {
    displayName: AZURE_DISPLAY_NAME,
    statusIcon: AzureStatusIcon,
    statusModal: AzureModal,
    configMenu: AzureConfigMenu,
  },
};

export const getProviderDisplayName = (id: ProviderId) =>
  providerComponentRegistry[id].displayName;

export const getProviderStatusIcon = (id: ProviderId) =>
  providerComponentRegistry[id].statusIcon;

export const getProviderStatusModal = (id: ProviderId) =>
  providerComponentRegistry[id].statusModal;

export const getProviderConfigMenu = (id: ProviderId) =>
  providerComponentRegistry[id].configMenu;
