import type {
  ActiveSection,
  TranscriptionSection,
  TranscriptionSequence,
  TranscriptionSequenceInput,
} from '@scribear/transcription-content-store';

export interface HostSnapshot {
  deviceName: string | null;
  activeSessionId: string | null;
  joinCode: string | null;
  joinCodeExpiresAtUnixMs: number | null;
  kioskServiceStatus: string;
  sessionStatus: {
    transcriptionServiceConnected: boolean;
    sourceDeviceConnected: boolean;
  } | null;
  isPaused: boolean;
  transcription: {
    commitedSections: TranscriptionSection[];
    activeSection: ActiveSection;
    finalizedTranscription: TranscriptionSequence[];
    inProgressTranscription: TranscriptionSequenceInput | null;
  };
}

interface BroadcastMessage {
  type: 'HOST_SNAPSHOT';
  payload: HostSnapshot;
}

const CHANNEL_NAME = 'room-displays';

function isHostSnapshotMessage(data: unknown): data is BroadcastMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as { type: unknown }).type === 'HOST_SNAPSHOT' &&
    'payload' in data
  );
}

export class BroadcastChannelSyncService {
  private readonly _channel = new BroadcastChannel(CHANNEL_NAME);

  publishSnapshot(payload: HostSnapshot) {
    const message: BroadcastMessage = { type: 'HOST_SNAPSHOT', payload };
    this._channel.postMessage(message);
  }

  onSnapshot(handler: (snapshot: HostSnapshot) => void): () => void {
    const listener = (event: MessageEvent<unknown>) => {
      if (isHostSnapshotMessage(event.data)) {
        handler(event.data.payload);
      }
    };
    this._channel.addEventListener('message', listener);
    return () => {
      this._channel.removeEventListener('message', listener);
    };
  }

  close() {
    this._channel.close();
  }
}
