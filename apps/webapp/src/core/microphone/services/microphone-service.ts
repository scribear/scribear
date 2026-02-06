import { EventEmitter } from 'eventemitter3';

import { tryCatch } from '@/utils/try-catch';

// import { RecordRTCPromisesHandler } from 'recordrtc';

interface MicrophoneServiceEvents {
  statusChange: (newStatus: MicrophoneServiceStatus) => void;
  analyserChange: (analyser: AnalyserNode | null) => void; 
  audioContextChange: (ctx: AudioContext | null) => void;
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
  private _micStream: MediaStream | null = null; 
  private _audioContext: AudioContext | null = null; 
  private _mediaSource: MediaStreamAudioSourceNode | null = null; 
  private _analyser: AnalyserNode | null = null; 
  private _permissionStatus?: PermissionStatus;

  get analyser() {
    return this._analyser; 
  } 

  get audioContext() { 
    return this._audioContext; 
  }


  private _status: MicrophoneServiceStatus = MicrophoneServiceStatus.INACTIVE;
  get status() {
    return this._status;
  }

  private _setStatus(newStatus: MicrophoneServiceStatus) {
    if (this._status === newStatus) return;

    this._status = newStatus;
    this.emit('statusChange', newStatus);
  }

  private _setAnalyser(analyser: AnalyserNode | null) { 
    this._analyser = analyser;
    this.emit('analyserChange', analyser); 
  } 

  private _setAudioContext(ctx: AudioContext | null) { 
    this._audioContext = ctx; 
    this.emit('audioContextChange', ctx); 
  } 


  constructor() {
    super();

    // Update microphone state if permissions change while active
    void this._beginStatusChangeListener();
  }

  private async _beginStatusChangeListener() {
    try {
      if (!navigator.permissions) return;

      const permissionStatus = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });

      permissionStatus.onchange = () => {
        if (this._status !== MicrophoneServiceStatus.ACTIVE) return;

        const state = this._permissionStatus?.state;

        if (state === 'prompt') {
          this.deactivateMicrophone();
          this._setStatus(MicrophoneServiceStatus.INFO_PROMPT);
        } else if (state === 'denied') {
          this.deactivateMicrophone();
          this._setStatus(MicrophoneServiceStatus.DENIED_PROMPT);
        } else if (state === 'granted'){
          this._setStatus(MicrophoneServiceStatus.ERROR);
        }
      };
    } catch (error) {
      console.error('Failed to begin microphone status change listener', error);
      this._setStatus(MicrophoneServiceStatus.ERROR);
    }
  }

  private async _checkPermission(): Promise<PermissionState> {
    if (!navigator.permissions) return 'prompt';
    const permissionStatus = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return permissionStatus.state;
  }

  private async _getMicStream(): Promise<MediaStream> {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    return micStream;
  }

    private _buildAudioPipeline(micStream: MediaStream) {
    this._teardownAudioPipeline(); 

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext; 
    const ctx = new AudioCtx(); 
    this._setAudioContext(ctx);

    const source = ctx.createMediaStreamSource(micStream); 
    this._mediaSource = source; 

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8; // smooth frequency bars a bit
    this._setAnalyser(analyser); 

    source.connect(analyser); 
  } 

  private _teardownAudioPipeline() { 
    try { 
      this._mediaSource?.disconnect(); 
    } catch {} 

    try { 
      this._analyser?.disconnect();
    } catch {} 

    this._mediaSource = null; 
    this._setAnalyser(null); 


    if (this._audioContext) { 
      const ctx = this._audioContext; 
      this._setAudioContext(null); 
      void ctx.close().catch(() => {}); 
    } 
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
      console.error('Failed to check microphone permission', initCheckError);
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
    if (getMicStreamError || !micStream) {
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
      return;
    }

    this._micStream = micStream;
    this._buildAudioPipeline(micStream);
    this._setStatus(MicrophoneServiceStatus.ACTIVE);
  }

  deactivateMicrophone() {
    if (this._micStream) { 
      this._micStream.getTracks().forEach(track => track.stop()); 

      this._micStream = null;
    }
    this._teardownAudioPipeline();
    this._setStatus(MicrophoneServiceStatus.INACTIVE);
  }

  dispose() { 
    this._permissionStatus && (this._permissionStatus.onchange = null); 
    this.removeAllListeners();
    this.deactivateMicrophone();
  }
}

export type { MicrophoneService };

// Create microphone service singleton
export const microphoneService = new MicrophoneService();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    microphoneService.dispose();
  });
}
