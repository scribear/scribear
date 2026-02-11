import { EventEmitter } from 'eventemitter3';

import { tryCatch } from '#src/utils/try-catch';

// import { RecordRTCPromisesHandler } from 'recordrtc';

interface MicrophoneServiceEvents {
  statusChange: (newStatus: MicrophoneServiceStatus) => void;
}

export enum MicrophoneServiceStatus {
  INACTIVE = 'INACTIVE',
  INFO_PROMPT = 'INFO_PROMPT',
  DENIED_PROMPT = 'DENIED_PROMPT',
  ACTIVATING = 'ACTIVATING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR',
}

class MicrophoneService extends EventEmitter<MicrophoneServiceEvents> {
  private _micStream: MediaStream | null;

  private _status: MicrophoneServiceStatus = MicrophoneServiceStatus.INACTIVE;
  get status() {
    return this._status;
  }

  private _setStatus(newStatus: MicrophoneServiceStatus) {
    this._status = newStatus;
    this.emit('statusChange', newStatus);
  }

  constructor() {
    super();
    this._micStream = null;

    // Update microphone state if permissions change while active
    void this._beginStatusChangeListener();
  }

  private async _beginStatusChangeListener() {
    try {
      const permissionStatus = await navigator.permissions.query({
        name: 'microphone',
      });

      permissionStatus.onchange = () => {
        if (this._status !== MicrophoneServiceStatus.ACTIVE) return;

        if (permissionStatus.state === 'prompt') {
          this.deactivateMicrophone();
          this._setStatus(MicrophoneServiceStatus.INFO_PROMPT);
        } else if (permissionStatus.state === 'denied') {
          this.deactivateMicrophone();
          this._setStatus(MicrophoneServiceStatus.DENIED_PROMPT);
        } else {
          this._setStatus(MicrophoneServiceStatus.ERROR);
        }
      };
    } catch (error) {
      console.error('Failed to begin microphone status change listener', error);
      this._setStatus(MicrophoneServiceStatus.ERROR);
    }
  }

  private async _checkPermission(): Promise<'granted' | 'prompt' | 'denied'> {
    const permissionStatus = await navigator.permissions.query({
      name: 'microphone',
    });
    return permissionStatus.state;
  }

  private async _getMicStream() {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    return micStream;
  }

  async activateMicrophone(): Promise<void> {
    if (
      this.status === MicrophoneServiceStatus.ACTIVATING ||
      this.status === MicrophoneServiceStatus.ACTIVE
    ) {
      return;
    }

    // Skip info prompt if this is retrying activation or already in info prompt
    const skipInfoPrompt =
      this.status === MicrophoneServiceStatus.INFO_PROMPT ||
      this.status === MicrophoneServiceStatus.DENIED_PROMPT ||
      this.status === MicrophoneServiceStatus.ERROR;

    this._setStatus(MicrophoneServiceStatus.ACTIVATING);

    // Check out current permissions
    const [initCheckError, initPermission] = await tryCatch(
      this._checkPermission(),
    );
    if (initCheckError) {
      console.error('Failed to check microphone permissioin', initCheckError);
      this._setStatus(MicrophoneServiceStatus.ERROR);
      return;
    }

    if (initPermission === 'prompt' && !skipInfoPrompt) {
      this._setStatus(MicrophoneServiceStatus.INFO_PROMPT);
      return;
    }
    if (initPermission === 'denied') {
      this._setStatus(MicrophoneServiceStatus.DENIED_PROMPT);
      return;
    }

    // If allowed, request mic from browser
    const [getMicStreamError, micStream] = await tryCatch(this._getMicStream());
    if (getMicStreamError) {
      // On failure to get mic, check if is because user denied access
      const [finalCheckError, finalPermission] = await tryCatch(
        this._checkPermission(),
      );
      if (!finalCheckError && finalPermission === 'denied') {
        this._setStatus(MicrophoneServiceStatus.DENIED_PROMPT);
        return;
      }

      console.error('Failed to activate microphone', getMicStreamError);
      this._setStatus(MicrophoneServiceStatus.ERROR);
    }

    this._micStream = micStream;
    this._setStatus(MicrophoneServiceStatus.ACTIVE);
  }

  deactivateMicrophone() {
    if (this._micStream !== null) {
      const tracks = this._micStream.getTracks();
      tracks.forEach((track) => {
        track.stop();
      });

      this._micStream = null;
    }

    this._setStatus(MicrophoneServiceStatus.INACTIVE);
  }
}

export type { MicrophoneService };

// Create microphone service singleton
export const microphoneService = new MicrophoneService();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    microphoneService.removeAllListeners();
    microphoneService.deactivateMicrophone();
  });
}
