import type { MicrophoneService } from '@/core/microphone/services/microphone-service';

import { BaseProviderInterface } from '../../base-provider-interface';
import type { ProviderInterface } from '../../provider-interface';
import { type AzureConfig, INITIAL_AZURE_STATUS } from '../config/azure-config';
import { AzureStatus } from '../types/azure-status';

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

  deactivateProvider() {
    this._stopProvider();
    this._setStatus(AzureStatus.INACTIVE);
  }

  unmute() {
    this._muted = false;
    if (this.status === AzureStatus.ACTIVE_MUTE) {
      this._startProvider();
    }
  }

  mute() {
    this._muted = true;
    if (this.status === AzureStatus.ACTIVE) {
      this._setStatus(AzureStatus.ACTIVE_MUTE);
      this._pauseProvider();
    }
  }
}
