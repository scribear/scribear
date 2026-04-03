import { EventEmitter } from 'eventemitter3';

import { type MicrophoneService } from '@scribear/microphone-store';
import type { TranscriptionSequenceInput } from '@scribear/transcription-content-store';

import {
  type ProviderConfigTypeMap,
  ProviderId,
  type ProviderInstance,
  type ProviderStatusTypeMap,
  providerRegistry,
} from './providers/provider-registry';

/**
 * Events emitted by {@link ProviderService} to communicate transcription output,
 * status changes, and loading lifecycle to the Redux middleware.
 */
interface ProviderServiceEvents {
  loadingStarted: () => void;
  loadingComplete: () => void;
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

// Lazily-populated map of instantiated providers, keyed by ProviderId.
type ProviderCache = Partial<{
  [K in ProviderId]: ProviderInstance<K>;
}>;

/**
 * Orchestrates transcription provider instances with lazy loading. Providers
 * are dynamically imported and instantiated on first use. Routes activation /
 * deactivation calls to the currently-selected provider, and re-emits provider
 * events (transcription content, status changes) for the Redux middleware.
 */
export class ProviderService extends EventEmitter<ProviderServiceEvents> {
  private _providers: ProviderCache = {};
  private _currentProviderId: ProviderId | null = null;
  private _activationToken = 0;
  private _loadingProvider = false;
  private _isMuted = false;
  private readonly _microphoneService: MicrophoneService;

  constructor(microphoneService: MicrophoneService) {
    super();
    this._microphoneService = microphoneService;
  }

  /**
   * Returns the cached provider instance for `id`, dynamically importing and
   * constructing it if this is the first time it has been requested.
   */
  private async _getOrLoadProvider<K extends ProviderId>(
    id: K,
  ): Promise<ProviderInstance<K>> {
    if (this._providers[id]) {
      return this._providers[id];
    }

    const Provider = await providerRegistry[id].loader();
    const provider = new Provider(this._microphoneService);

    provider.on('statusChange', (newStatus) => {
      this.emit('statusChange', id, newStatus);
    });

    if (this._isMuted) {
      provider.mute();
    } else {
      provider.unmute();
    }

    (this._providers as Record<ProviderId, ProviderInstance<ProviderId>>)[id] =
      provider;
    return provider;
  }

  private async _activateProvider<K extends ProviderId>(
    id: K,
    config: ProviderConfigTypeMap[K],
  ) {
    this.deactivate();
    this._loadingProvider = true;
    this.emit('loadingStarted');

    const token = ++this._activationToken;
    const provider = await this._getOrLoadProvider(id);

    // A newer activation started while we were loading, abort this one.
    if (this._activationToken !== token) return;
    this._currentProviderId = id;
    this._loadingProvider = false;
    this.emit('loadingComplete');

    provider.on('commitParagraphBreak', () => {
      this.emit('commitParagraphBreak');
    });
    provider.on('appendFinalizedTranscription', (sequence) => {
      this.emit('appendFinalizedTranscription', sequence);
    });
    provider.on('replaceInProgressTranscription', (sequence) => {
      this.emit('replaceInProgressTranscription', sequence);
    });
    provider.on('clearTranscription', () => {
      this.emit('clearTranscription');
    });

    await provider.activateProvider(config);
  }

  /**
   * Switches to the given provider if it is not already active, lazy-loading
   * the provider module on first use.
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
   */
  async updateConfig<K extends ProviderId>(
    id: K,
    config: ProviderConfigTypeMap[K],
  ) {
    if (this._currentProviderId !== id) return;
    await this._activateProvider(id, config);
  }

  /**
   * Deactivates the currently active provider and clears its transcription
   * event listeners.
   */
  deactivate() {
    if (this._loadingProvider) {
      this.emit('loadingComplete');
      this._loadingProvider = false;
    }
    if (this._currentProviderId === null) return;

    const currentProvider = this._providers[this._currentProviderId];
    this._currentProviderId = null;
    if (!currentProvider) return;

    currentProvider.deactivateProvider();
    currentProvider.removeAllListeners('commitParagraphBreak');
    currentProvider.removeAllListeners('appendFinalizedTranscription');
    currentProvider.removeAllListeners('replaceInProgressTranscription');
    currentProvider.removeAllListeners('clearTranscription');
  }

  /**
   * Unmutes all cached provider instances.
   */
  unmute() {
    this._isMuted = false;
    for (const provider of Object.values(this._providers)) {
      provider.unmute();
    }
  }

  /**
   * Mutes all cached provider instances.
   */
  mute() {
    this._isMuted = true;
    for (const provider of Object.values(this._providers)) {
      provider.mute();
    }
  }
}
