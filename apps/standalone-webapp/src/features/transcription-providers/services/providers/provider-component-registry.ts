import { lazy } from 'react';
import type React from 'react';

import { AzureStatusIcon } from './azure/components/azure-status-icon';
import { AZURE_DISPLAY_NAME } from './azure/config/azure-config';
import { ProviderId } from './provider-registry';
import { StreamtextStatusIcon } from './streamtext/components/streamtext-status-icon';
import { STREAMTEXT_DISPLAY_NAME } from './streamtext/config/streamtext-config';
import { WebspeechStatusIcon } from './webspeech/components/webspeech-status-icon';
import { WEBSPEECH_DISPLAY_NAME } from './webspeech/config/webspeech-config';

const AzureConfigMenu = lazy(() =>
  import('./azure/components/azure-config-menu').then((m) => ({
    default: m.AzureConfigMenu,
  })),
);
const AzureModal = lazy(() =>
  import('./azure/components/azure-modal').then((m) => ({
    default: m.AzureModal,
  })),
);

const StreamtextConfigMenu = lazy(() =>
  import('./streamtext/components/streamtext-config-menu').then((m) => ({
    default: m.StreamtextConfigMenu,
  })),
);
const StreamtextModal = lazy(() =>
  import('./streamtext/components/streamtext-modal').then((m) => ({
    default: m.StreamtextModal,
  })),
);

const WebspeechConfigMenu = lazy(() =>
  import('./webspeech/components/webspeech-config-menu').then((m) => ({
    default: m.WebspeechConfigMenu,
  })),
);
const WebspeechModal = lazy(() =>
  import('./webspeech/components/webspeech-modal').then((m) => ({
    default: m.WebspeechModal,
  })),
);

/**
 * Props passed to each provider's configuration menu component.
 */
export interface ProviderConfigMenuProps {
  // Called when the menu requests to be closed. When true, the consumer should
  // display an unsaved-changes confirmation before actually closing.
  onClose: (showConfirmPrompt: boolean) => void;
  // Called whenever the form's dirty state changes, so the parent shell can
  // decide whether to prompt for confirmation on backdrop/escape close.
  onDirtyChange: (isDirty: boolean) => void;
}

// Maps each `ProviderId` to its display name and React UI components.
type ProviderComponentRegistry = Record<
  ProviderId,
  {
    displayName: string;
    statusIcon: React.ComponentType;
    statusModal: React.ComponentType;
    configMenu: React.ComponentType<ProviderConfigMenuProps>;
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
