import { EventEmitter } from 'eventemitter3';

import {
  type MicrophoneService,
  microphoneService,
} from '#src/core/microphone/services/microphone-service';
import type { TranscriptionSequence } from '#src/core/transcription-content/store/transcription-content-slice';

import {
  type ProviderConfigTypeMap,
  ProviderId,
  type ProviderInstance,
  type ProviderStatusTypeMap,
  providerRegistry,
} from './providers/provider-registry';

interface ProviderServiceEvents {
  commitParagraphBreak: () => void;
  appendFinalizedTranscription: (sequence: TranscriptionSequence) => void;
  replaceInProgressTranscription: (sequence: TranscriptionSequence) => void;
  clearTranscription: () => void;
  statusChange: <K extends ProviderId>(
    providerId: K,
    newStatus: ProviderStatusTypeMap[K],
  ) => void;
}

type ProviderStore = {
  [K in ProviderId]: ProviderInstance<K>;
};

class ProviderService extends EventEmitter<ProviderServiceEvents> {
  private _providers: ProviderStore;
  private _currentProviderId: ProviderId | null = null;

  get providerStatuses() {
    return Object.fromEntries(
      Object.values(ProviderId).map((id) => [id, this._providers[id].status]),
    ) as unknown as ProviderStatusTypeMap;
  }

  constructor(microphoneService: MicrophoneService) {
    super();

    this._providers = Object.fromEntries(
      Object.values(ProviderId).map((id) => {
        const Provider = providerRegistry[id].constructor;
        return [id, new Provider(microphoneService)];
      }),
    ) as unknown as ProviderStore;

    for (const providerId of Object.values(ProviderId)) {
      this._providers[providerId].on('statusChange', (newStatus) => {
        this.emit('statusChange', providerId, newStatus);
      });
    }
  }

  private _onCommitParagraphBreak() {
    this.emit('commitParagraphBreak');
  }
  private _onAppendFinalizedTranscription(sequence: TranscriptionSequence) {
    this.emit('appendFinalizedTranscription', sequence);
  }
  private _onReplaceInProgressTranscription(sequence: TranscriptionSequence) {
    this.emit('replaceInProgressTranscription', sequence);
  }
  private _onClearTranscription() {
    this.emit('clearTranscription');
  }

  private async _activateProvider<K extends ProviderId>(
    id: K,
    config: ProviderConfigTypeMap[K],
  ) {
    this.deactivate();

    this._currentProviderId = id;
    const currentProvider = this._providers[
      this._currentProviderId
    ] as ProviderInstance<K>;

    currentProvider.on(
      'commitParagraphBreak',
      this._onCommitParagraphBreak.bind(this),
    );
    currentProvider.on(
      'appendFinalizedTranscription',
      this._onAppendFinalizedTranscription.bind(this),
    );
    currentProvider.on(
      'replaceInProgressTranscription',
      this._onReplaceInProgressTranscription.bind(this),
    );
    currentProvider.on(
      'clearTranscription',
      this._onClearTranscription.bind(this),
    );

    await currentProvider.activateProvider(config);
  }

  async switchProvider<K extends ProviderId>(
    id: K,
    config: ProviderConfigTypeMap[K],
  ) {
    if (this._currentProviderId === id) return;
    await this._activateProvider(id, config);
  }

  async updateConfig<K extends ProviderId>(
    id: K,
    config: ProviderConfigTypeMap[K],
  ) {
    if (this._currentProviderId !== id) return;
    await this._activateProvider(id, config);
  }

  deactivate() {
    if (this._currentProviderId === null) return;
    const currentProvider = this._providers[this._currentProviderId];

    currentProvider.deactivateProvider();

    currentProvider.removeListener('commitParagraphBreak');
    currentProvider.removeListener('appendFinalizedTranscription');
    currentProvider.removeListener('replaceInProgressTranscription');
    currentProvider.removeListener('clearTranscription');

    this._currentProviderId = null;
  }

  unmute() {
    for (const providerId of Object.values(ProviderId)) {
      this._providers[providerId].unmute();
    }
  }

  mute() {
    for (const providerId of Object.values(ProviderId)) {
      this._providers[providerId].mute();
    }
  }
}

export type { ProviderService };

export const providerService = new ProviderService(microphoneService);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    providerService.removeAllListeners();
    providerService.deactivate();
  });
}
