import { EventEmitter } from 'eventemitter3';

import { type MicrophoneService } from '@scribear/microphone-store';
import type { TranscriptionSequenceInput } from '@scribear/transcription-content-store';

import { appMicrophoneService } from '#src/app-microphone-service';

import {
  type ProviderConfigTypeMap,
  ProviderId,
  type ProviderInstance,
  type ProviderStatusTypeMap,
  providerRegistry,
} from './providers/provider-registry';

/**
 * Events emitted by {@link ProviderService} to communicate transcription output and status changes to the Redux middleware.
 */
interface ProviderServiceEvents {
  commitParagraphBreak: () => void;
  appendFinalizedTranscription: (sequence: TranscriptionSequenceInput) => void;
  replaceInProgressTranscription: (
    sequence: TranscriptionSequenceInput,
  ) => void;
  clearTranscription: () => void;
  statusChange: <K extends ProviderId>(
    providerId: K,
    newStatus: ProviderStatusTypeMap[K],
  ) => void;
}

// Map that holds one instantiated provider per `ProviderId`.
type ProviderStore = {
  [K in ProviderId]: ProviderInstance<K>;
};

/**
 * Orchestrates all transcription provider instances. Maintains a pool of every
 * registered provider (one instance per `ProviderId`), routes activation /
 * deactivation calls to the currently-selected provider, and re-emits
 * provider events (transcription content, status changes) for the Redux
 * middleware to consume.
 */
class ProviderService extends EventEmitter<ProviderServiceEvents> {
  private _providers: ProviderStore;
  private _currentProviderId: ProviderId | null = null;

  /**
   * Returns a snapshot of every provider's current status, keyed by `ProviderId`.
   */
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
  private _onAppendFinalizedTranscription(
    sequence: TranscriptionSequenceInput,
  ) {
    this.emit('appendFinalizedTranscription', sequence);
  }
  private _onReplaceInProgressTranscription(
    sequence: TranscriptionSequenceInput,
  ) {
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

  /**
   * Switches to the given provider if it is not already active.
   * Deactivates the current provider before activating the new one.
   *
   * @param id - The provider to activate.
   * @param config - Configuration to pass to the new provider.
   */
  async switchProvider<K extends ProviderId>(
    id: K,
    config: ProviderConfigTypeMap[K],
  ) {
    if (this._currentProviderId === id) return;
    await this._activateProvider(id, config);
  }

  /**
   * Re-activates the currently active provider with a new config.
   * No-op if the given provider is not the active one.
   *
   * @param id - The provider whose config has changed.
   * @param config - The updated configuration to apply.
   */
  async updateConfig<K extends ProviderId>(
    id: K,
    config: ProviderConfigTypeMap[K],
  ) {
    if (this._currentProviderId !== id) return;
    await this._activateProvider(id, config);
  }

  /**
   * Deactivates the currently active provider and clears all its event listeners.
   */
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

  /**
   * Unmutes all provider instances (called when the microphone becomes active).
   */
  unmute() {
    for (const providerId of Object.values(ProviderId)) {
      this._providers[providerId].unmute();
    }
  }

  /**
   * Mutes all provider instances (called when the microphone is deactivated).
   */
  mute() {
    for (const providerId of Object.values(ProviderId)) {
      this._providers[providerId].mute();
    }
  }
}

export type { ProviderService };

// Singleton `ProviderService` instance shared across the application.
export const providerService = new ProviderService(appMicrophoneService);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    providerService.removeAllListeners();
    providerService.deactivate();
  });
}
