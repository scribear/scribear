import type React from 'react';

import { AzureConfigMenu } from './azure/components/azure-config-menu';
import { AzureModal } from './azure/components/azure-modal';
import { AzureStatusIcon } from './azure/components/azure-status-icon';
import { AZURE_DISPLAY_NAME } from './azure/config/azure-config';
import { ProviderId } from './provider-registry';
import { StreamtextConfigMenu } from './streamtext/components/streamtext-config-menu';
import { StreamtextModal } from './streamtext/components/streamtext-modal';
import { StreamtextStatusIcon } from './streamtext/components/streamtext-status-icon';
import { STREAMTEXT_DISPLAY_NAME } from './streamtext/config/streamtext-config';
import { WebspeechConfigMenu } from './webspeech/components/webspeech-config-menu';
import { WebspeechModal } from './webspeech/components/webspeech-modal';
import { WebspeechStatusIcon } from './webspeech/components/webspeech-status-icon';
import { WEBSPEECH_DISPLAY_NAME } from './webspeech/config/webspeech-config';

/**
 * Props passed to each provider's configuration menu component.
 */
export interface ProviderConfigMenuProps {
  // Called when the menu requests to be closed. When true, the consumer should
  // display an unsaved-changes confirmation before actually closing.
  onClose: (showConfirmPrompt: boolean) => void;
}

// Maps each `ProviderId` to its display name and React UI components.
type ProviderComponentRegistry = Record<
  ProviderId,
  {
    displayName: string;
    statusIcon: () => React.ReactNode;
    statusModal: () => React.ReactNode;
    configMenu: (props: ProviderConfigMenuProps) => React.ReactNode;
  }
>;

/**
 * Registry that associates each `ProviderId` with its human-readable display
 * name and the React components used for the status icon, status modal, and
 * configuration menu.
 */
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
  [ProviderId.STREAMTEXT]: {
    displayName: STREAMTEXT_DISPLAY_NAME,
    statusIcon: StreamtextStatusIcon,
    statusModal: StreamtextModal,
    configMenu: StreamtextConfigMenu,
  },
};

/**
 * Returns the human-readable display name for the given provider.
 */
export const getProviderDisplayName = (id: ProviderId) =>
  providerComponentRegistry[id].displayName;

/**
 * Returns the status icon component for the given provider.
 */
export const getProviderStatusIcon = (id: ProviderId) =>
  providerComponentRegistry[id].statusIcon;

/**
 * Returns the status modal component for the given provider.
 */
export const getProviderStatusModal = (id: ProviderId) =>
  providerComponentRegistry[id].statusModal;

/**
 * Returns the configuration menu component for the given provider.
 */
export const getProviderConfigMenu = (id: ProviderId) =>
  providerComponentRegistry[id].configMenu;
