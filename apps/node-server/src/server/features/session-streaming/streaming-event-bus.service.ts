export interface TranscriptEvent {
  text: string[];
  starts: number[] | null;
  ends: number[] | null;
}

type AudioChunkListener = (chunk: Buffer) => void;
type TranscriptListener = (event: TranscriptEvent) => void;

/**
 * In-memory pub/sub for audio chunks and transcription events per session.
 * Bridges audio-source WebSocket connections with session-client connections
 * via the transcription service pipeline.
 */
export class StreamingEventBusService {
  private _audioChunkListeners = new Map<string, Set<AudioChunkListener>>();
  private _ipTranscriptListeners = new Map<string, Set<TranscriptListener>>();
  private _finalTranscriptListeners = new Map<
    string,
    Set<TranscriptListener>
  >();

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
   * Subscribes a listener to in-progress transcript events for a session.
   *
   * @param sessionId - The session to subscribe to.
   * @param listener - Called with each in-progress transcript.
   * @returns A function that removes this listener when called.
   */
  onIpTranscript(sessionId: string, listener: TranscriptListener): () => void {
    return this._addListener(this._ipTranscriptListeners, sessionId, listener);
  }

  /**
   * Emits an in-progress transcript event to all listeners for the given session.
   *
   * @param sessionId - The session to emit to.
   * @param event - The transcript event data.
   */
  emitIpTranscript(sessionId: string, event: TranscriptEvent): void {
    for (const listener of this._ipTranscriptListeners.get(sessionId) ?? []) {
      listener(event);
    }
  }

  /**
   * Subscribes a listener to final transcript events for a session.
   *
   * @param sessionId - The session to subscribe to.
   * @param listener - Called with each final transcript.
   * @returns A function that removes this listener when called.
   */
  onFinalTranscript(
    sessionId: string,
    listener: TranscriptListener,
  ): () => void {
    return this._addListener(
      this._finalTranscriptListeners,
      sessionId,
      listener,
    );
  }

  /**
   * Emits a final transcript event to all listeners for the given session.
   *
   * @param sessionId - The session to emit to.
   * @param event - The transcript event data.
   */
  emitFinalTranscript(sessionId: string, event: TranscriptEvent): void {
    for (const listener of this._finalTranscriptListeners.get(sessionId) ??
      []) {
      listener(event);
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
