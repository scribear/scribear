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

export enum ProviderId {
  WEBSPEECH = 'WEBSPEECH',
  AZURE = 'AZURE',
  STREAMTEXT = 'STREAMTEXT',
}

export interface ProviderConfigTypeMap {
  [ProviderId.WEBSPEECH]: WebspeechConfig;
  [ProviderId.AZURE]: AzureConfig;
  [ProviderId.STREAMTEXT]: StreamtextConfig;
}

export interface ProviderStatusTypeMap {
  [ProviderId.WEBSPEECH]: WebspeechStatus;
  [ProviderId.AZURE]: AzureStatus;
  [ProviderId.STREAMTEXT]: StreamtextStatus;
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
  [ProviderId.STREAMTEXT]: {
    initialConfig: DEFAULT_STREAMTEXT_CONFIG,
    initialStatus: INITIAL_STREAMTEXT_STATUS,
    constructor: StreamtextProvider,
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
