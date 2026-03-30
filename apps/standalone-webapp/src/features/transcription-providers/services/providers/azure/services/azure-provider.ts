import type { MicrophoneService } from '@scribear/microphone-store';

import { BaseProviderInterface } from '../../base-provider-interface';
import type { ProviderInterface } from '../../provider-interface';
import { type AzureConfig, INITIAL_AZURE_STATUS } from '../config/azure-config';
import { AzureStatus } from '../types/azure-status';

/**
 * Transcription provider implementation for Microsoft Azure Speech-to-Text.
 * Connects to the Azure Cognitive Services speech API, emits transcription
 * events, and respects microphone mute/unmute state.
 *
 * Note: the current implementation is a stub/placeholder that simulates the
 * connection lifecycle with a timeout rather than making real Azure SDK calls.
 */
export class AzureProvider
  extends BaseProviderInterface<AzureStatus>
  implements ProviderInterface<AzureConfig, AzureStatus>
{
  private _muted = true;
  private _microphoneService;

  constructor(microphoneService: MicrophoneService) {
    super(INITIAL_AZURE_STATUS);
    this._microphoneService = microphoneService;
  }

  private _startProvider() {
    this._setStatus(AzureStatus.ACTIVE);
    this._appendFinalizedTranscription({
      text: ['Microsoft Azure'],
    });
  }

  private _pauseProvider() {
    this._setStatus(AzureStatus.ACTIVE_MUTE);
  }

  private _stopProvider() {
    this._setStatus(AzureStatus.INACTIVE);
  }

  /**
   * Initiates the Azure connection using the provided credentials. Sets status
   * to `CONNECTING`, then transitions to `ACTIVE` or `ACTIVE_MUTE` once ready.
   * No-op if already connecting or active.
   *
   * @param config - The Azure region ID and API key to use.
   */
  async activateProvider(config: AzureConfig) {
    if (
      this.status === AzureStatus.CONNECTING ||
      this.status === AzureStatus.ACTIVE ||
      this.status === AzureStatus.ACTIVE_MUTE
    ) {
      return;
    }
    this._setStatus(AzureStatus.CONNECTING);

    await new Promise((r) => setTimeout(r, 3000));
    console.log(config);

    // If provider was deactivated before finishing
    if (this.status === AzureStatus.INACTIVE) return;
    if (this._muted) {
      this._pauseProvider();
    } else {
      this._startProvider();
    }
  }

  /**
   * Stops the Azure connection and resets status to `INACTIVE`.
   */
  deactivateProvider() {
    this._stopProvider();
    this._setStatus(AzureStatus.INACTIVE);
  }

  /**
   * Clears the muted flag and resumes transcription if the provider is paused.
   */
  unmute() {
    this._muted = false;
    if (this.status === AzureStatus.ACTIVE_MUTE) {
      this._startProvider();
    }
  }

  /**
   * Sets the muted flag and pauses transcription if the provider is currently active.
   */
  mute() {
    this._muted = true;
    if (this.status === AzureStatus.ACTIVE) {
      this._setStatus(AzureStatus.ACTIVE_MUTE);
      this._pauseProvider();
    }
  }
}
