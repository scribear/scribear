import type { MicrophoneService } from '#src/core/microphone/services/microphone-service';

import {
  type AzureConfig,
  DEFAULT_AZURE_CONFIG,
  INITIAL_AZURE_STATUS,
} from './azure/config/azure-config';
import { AzureProvider } from './azure/services/azure-provider';
import type { AzureStatus } from './azure/types/azure-status';
import type { ProviderInterface } from './provider-interface';
import {
  DEFAULT_WEBSPEECH_CONFIG,
  INITIAL_WEBSPEECH_STATUS,
  type WebspeechConfig,
} from './webspeech/config/webspeech-config';
import { WebspeechProvider } from './webspeech/services/webspeech-provider';
import type { WebspeechStatus } from './webspeech/types/webspeech-status';

export enum ProviderId {
  WEBSPEECH = 'WEBSPEECH',
  AZURE = 'AZURE',
}

export interface ProviderConfigTypeMap {
  [ProviderId.WEBSPEECH]: WebspeechConfig;
  [ProviderId.AZURE]: AzureConfig;
}

export interface ProviderStatusTypeMap {
  [ProviderId.WEBSPEECH]: WebspeechStatus;
  [ProviderId.AZURE]: AzureStatus;
}

export type ProviderInstance<K extends ProviderId> = ProviderInterface<
  ProviderConfigTypeMap[K],
  ProviderStatusTypeMap[K]
>;

type ProviderRegistry = {
  [K in ProviderId]: {
    initialConfig: ProviderConfigTypeMap[K];
    initialStatus: ProviderStatusTypeMap[K];
    constructor: new (
      microphoneService: MicrophoneService,
    ) => ProviderInstance<K>;
  };
};

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
};

export const getInitialConfigState = () => {
  return Object.fromEntries(
    Object.values(ProviderId).map((id) => [
      id,
      providerRegistry[id].initialConfig,
    ]),
  ) as unknown as ProviderConfigTypeMap;
};

export const getInitialStatusState = () => {
  return Object.fromEntries(
    Object.values(ProviderId).map((id) => [
      id,
      providerRegistry[id].initialStatus,
    ]),
  ) as unknown as ProviderStatusTypeMap;
};
