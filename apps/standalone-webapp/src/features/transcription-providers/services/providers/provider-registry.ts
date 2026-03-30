import type { MicrophoneService } from '@scribear/microphone-store';

import {
  type AzureConfig,
  DEFAULT_AZURE_CONFIG,
  INITIAL_AZURE_STATUS,
} from './azure/config/azure-config';
import { AzureProvider } from './azure/services/azure-provider';
import type { AzureStatus } from './azure/types/azure-status';
import type { ProviderInterface } from './provider-interface';
import {
  DEFAULT_STREAMTEXT_CONFIG,
  INITIAL_STREAMTEXT_STATUS,
  type StreamtextConfig,
} from './streamtext/config/streamtext-config';
import { StreamtextProvider } from './streamtext/services/streamtext-provider';
import type { StreamtextStatus } from './streamtext/types/streamtext-status';
import {
  DEFAULT_WEBSPEECH_CONFIG,
  INITIAL_WEBSPEECH_STATUS,
  type WebspeechConfig,
} from './webspeech/config/webspeech-config';
import { WebspeechProvider } from './webspeech/services/webspeech-provider';
import type { WebspeechStatus } from './webspeech/types/webspeech-status';

/**
 * Unique identifiers for all supported transcription providers.
 * Used as keys in the provider registry, config slice, and status slice.
 */
export enum ProviderId {
  WEBSPEECH = 'WEBSPEECH',
  AZURE = 'AZURE',
  STREAMTEXT = 'STREAMTEXT',
}

/**
 * Maps each `ProviderId` to its corresponding configuration type.
 */
export interface ProviderConfigTypeMap {
  [ProviderId.WEBSPEECH]: WebspeechConfig;
  [ProviderId.AZURE]: AzureConfig;
  [ProviderId.STREAMTEXT]: StreamtextConfig;
}

/**
 * Maps each `ProviderId` to its corresponding runtime status type.
 */
export interface ProviderStatusTypeMap {
  [ProviderId.WEBSPEECH]: WebspeechStatus;
  [ProviderId.AZURE]: AzureStatus;
  [ProviderId.STREAMTEXT]: StreamtextStatus;
}

// A fully-typed provider instance for a specific `ProviderId`.
export type ProviderInstance<K extends ProviderId> = ProviderInterface<
  ProviderConfigTypeMap[K],
  ProviderStatusTypeMap[K]
>;

// Internal registry type mapping each provider ID to its metadata and constructor.
type ProviderRegistry = {
  [K in ProviderId]: {
    initialConfig: ProviderConfigTypeMap[K];
    initialStatus: ProviderStatusTypeMap[K];
    constructor: new (
      microphoneService: MicrophoneService,
    ) => ProviderInstance<K>;
  };
};

/**
 * Central registry of all transcription providers. Each entry holds the
 * provider's default config, initial status, and constructor class.
 */
export const providerRegistry: ProviderRegistry = {
  [ProviderId.WEBSPEECH]: {
    initialConfig: DEFAULT_WEBSPEECH_CONFIG,
    initialStatus: INITIAL_WEBSPEECH_STATUS,
    constructor: WebspeechProvider,
  },
  [ProviderId.AZURE]: {
    initialConfig: DEFAULT_AZURE_CONFIG,
    initialStatus: INITIAL_AZURE_STATUS,
    constructor: AzureProvider,
  },
  [ProviderId.STREAMTEXT]: {
    initialConfig: DEFAULT_STREAMTEXT_CONFIG,
    initialStatus: INITIAL_STREAMTEXT_STATUS,
    constructor: StreamtextProvider,
  },
};

/**
 * Builds the initial Redux `providerConfig` state by collecting each
 * provider's default config from the registry.
 *
 * @returns A `ProviderConfigTypeMap` populated with each provider's defaults.
 */
export const getInitialConfigState = () => {
  return Object.fromEntries(
    Object.values(ProviderId).map((id) => [
      id,
      providerRegistry[id].initialConfig,
    ]),
  ) as unknown as ProviderConfigTypeMap;
};

/**
 * Builds the initial Redux `providerStatus` state by collecting each
 * provider's initial status from the registry.
 *
 * @returns A `ProviderStatusTypeMap` populated with each provider's initial status.
 */
export const getInitialStatusState = () => {
  return Object.fromEntries(
    Object.values(ProviderId).map((id) => [
      id,
      providerRegistry[id].initialStatus,
    ]),
  ) as unknown as ProviderStatusTypeMap;
};
