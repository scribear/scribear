export interface TranscriptSequenceEvent {
  text: string[];
  starts: number[] | null;
  ends: number[] | null;
}

export interface TranscriptEvent {
  final: TranscriptSequenceEvent | null;
  inProgress: TranscriptSequenceEvent | null;
}

export interface SessionStatusEvent {
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
}

type AudioChunkListener = (chunk: Buffer) => void;
type TranscriptListener = (event: TranscriptEvent) => void;
type SessionStatusListener = (event: SessionStatusEvent) => void;
type SessionEndListener = () => void;

/**
 * In-memory pub/sub for audio chunks and transcription events per session.
 * Bridges audio-source WebSocket connections with session-client connections
 * via the transcription service pipeline.
 */
export class StreamingEventBusService {
  private _audioChunkListeners = new Map<string, Set<AudioChunkListener>>();
  private _transcriptListeners = new Map<string, Set<TranscriptListener>>();
  private _sessionStatusListeners = new Map<
    string,
    Set<SessionStatusListener>
  >();
  private _sessionEndListeners = new Map<string, Set<SessionEndListener>>();

  /**
   * Subscribes a listener to audio chunk events for a session.
   *
   * @param sessionId - The session to subscribe to.
   * @param listener - Called with each audio chunk.
   * @returns A function that removes this listener when called.
   */
  onAudioChunk(sessionId: string, listener: AudioChunkListener): () => void {
    return this._addListener(this._audioChunkListeners, sessionId, listener);
  }

  /**
   * Emits a raw audio chunk to all listeners for the given session.
   *
   * @param sessionId - The session to emit to.
   * @param chunk - The binary audio data.
   */
  emitAudioChunk(sessionId: string, chunk: Buffer): void {
    for (const listener of this._audioChunkListeners.get(sessionId) ?? []) {
      listener(chunk);
    }
  }

  /**
   * Subscribes a listener to transcript events for a session.
   *
   * @param sessionId - The session to subscribe to.
   * @param listener - Called with each transcript event containing final and/or in-progress data.
   * @returns A function that removes this listener when called.
   */
  onTranscript(sessionId: string, listener: TranscriptListener): () => void {
    return this._addListener(this._transcriptListeners, sessionId, listener);
  }

  /**
   * Emits a transcript event to all listeners for the given session.
   *
   * @param sessionId - The session to emit to.
   * @param event - The transcript event data with optional final and in-progress sequences.
   */
  emitTranscript(sessionId: string, event: TranscriptEvent): void {
    for (const listener of this._transcriptListeners.get(sessionId) ?? []) {
      listener(event);
    }
  }

  /**
   * Subscribes a listener to session status events for a session.
   *
   * @param sessionId - The session to subscribe to.
   * @param listener - Called with each status update.
   * @returns A function that removes this listener when called.
   */
  onSessionStatus(
    sessionId: string,
    listener: SessionStatusListener,
  ): () => void {
    return this._addListener(this._sessionStatusListeners, sessionId, listener);
  }

  /**
   * Emits a session status event to all listeners for the given session.
   *
   * @param sessionId - The session to emit to.
   * @param event - The status event data.
   */
  emitSessionStatus(sessionId: string, event: SessionStatusEvent): void {
    for (const listener of this._sessionStatusListeners.get(sessionId) ?? []) {
      listener(event);
    }
  }

  /**
   * Subscribes a listener to session end events for a session.
   *
   * @param sessionId - The session to subscribe to.
   * @param listener - Called when the session ends.
   * @returns A function that removes this listener when called.
   */
  onSessionEnd(sessionId: string, listener: SessionEndListener): () => void {
    return this._addListener(this._sessionEndListeners, sessionId, listener);
  }

  /**
   * Emits a session end event to all listeners for the given session.
   *
   * @param sessionId - The session to emit to.
   */
  emitSessionEnd(sessionId: string): void {
    for (const listener of this._sessionEndListeners.get(sessionId) ?? []) {
      listener();
    }
  }

  private _addListener<T>(
    map: Map<string, Set<T>>,
    sessionId: string,
    listener: T,
  ): () => void {
    let set = map.get(sessionId);
    if (!set) {
      set = new Set();
      map.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      map.get(sessionId)?.delete(listener);
    };
  }
}
