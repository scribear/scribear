import type WebSocket from 'ws';

import type { BaseDependencies } from '@scribear/base-fastify-server';
import TranscriptionStreamClient from '@scribear/transcription-service-client';

import type { TranscriptionConfig } from '../../app-config/app-config.js';

/**
 * Per-session transcription configuration.
 * Supplied at room creation time (e.g. via POST /rooms) and used when
 * the TranscriptionStreamClient connects to the transcription service.
 */
export interface TranscriptionSessionConfig {
    /** Transcription provider key (e.g. 'whisper', 'debug') */
    providerKey: string;
    /** Whether to use SSL when connecting to the transcription service */
    useSsl: boolean;
    /** Audio sample rate in Hz (e.g. 16000) */
    sampleRate: number;
    /** Number of audio channels (e.g. 1 for mono) */
    numChannels: number;
}

export const DEFAULT_TRANSCRIPTION_SESSION_CONFIG: TranscriptionSessionConfig = {
    providerKey: 'whisper',
    useSsl: false,
    sampleRate: 16000,
    numChannels: 1,
};

/**
 * Represents a single active room (session)
 * Each room has one audio source (kiosk) and multiple transcript subscribers (students)
 */
export interface Room {
    sessionId: string;
    transcriptionSessionConfig: TranscriptionSessionConfig;
    transcriptionClient: TranscriptionStreamClient | null;
    sourceSocket: WebSocket | null;
    subscribers: Set<WebSocket>;
    createdAt: Date;
}

export interface RoomInfo {
    sessionId: string;
    hasSource: boolean;
    subscriberCount: number;
    createdAt: Date;
    transcriptionConnected: boolean;
    transcriptionSessionConfig: TranscriptionSessionConfig;
}

/**
 * Manages active rooms for the node-server.
 * Each room corresponds to a session and bridges audio from a kiosk
 * to the transcription service, fanning out transcripts to subscribers.
 */
export class RoomManagerService {
    private _log: BaseDependencies['logger'];
    private _rooms: Map<string, Room>;
    private _transcriptionConfig: TranscriptionConfig;

    constructor(
        logger: BaseDependencies['logger'],
        transcriptionConfig: TranscriptionConfig,
    ) {
        this._log = logger;
        this._rooms = new Map();
        this._transcriptionConfig = transcriptionConfig;
    }

    /**
     * Create a new room for a session
     * @param sessionId Unique session identifier
     * @param config Optional per-session transcription config; defaults applied for missing fields
     */
    createRoom(
        sessionId: string,
        config?: Partial<TranscriptionSessionConfig>,
    ): Room {
        if (this._rooms.has(sessionId)) {
            this._log.warn({ sessionId }, 'Room already exists for session');
            return this._rooms.get(sessionId)!;
        }

        const transcriptionSessionConfig: TranscriptionSessionConfig = {
            ...DEFAULT_TRANSCRIPTION_SESSION_CONFIG,
            ...config,
        };

        const room: Room = {
            sessionId,
            transcriptionSessionConfig,
            transcriptionClient: null,
            sourceSocket: null,
            subscribers: new Set(),
            createdAt: new Date(),
        };

        this._rooms.set(sessionId, room);
        this._log.info(
            { sessionId, transcriptionSessionConfig },
            'Room created',
        );

        return room;
    }

    /**
     * Get a room by session ID
     */
    getRoom(sessionId: string): Room | undefined {
        return this._rooms.get(sessionId);
    }

    /**
     * Get or create a room for a session
     * @param sessionId Unique session identifier
     * @param config Optional per-session transcription config (only used when creating)
     */
    getOrCreateRoom(
        sessionId: string,
        config?: Partial<TranscriptionSessionConfig>,
    ): Room {
        const existing = this._rooms.get(sessionId);
        if (existing) return existing;
        return this.createRoom(sessionId, config);
    }

    /**
     * Remove a room and clean up resources
     */
    removeRoom(sessionId: string): void {
        const room = this._rooms.get(sessionId);
        if (!room) return;

        // Disconnect transcription client
        if (room.transcriptionClient) {
            room.transcriptionClient.disconnect();
            room.transcriptionClient = null;
        }

        // Close source socket
        if (room.sourceSocket) {
            room.sourceSocket.close(1000, 'Room closed');
            room.sourceSocket = null;
        }

        // Close all subscriber sockets
        for (const subscriber of room.subscribers) {
            subscriber.close(1000, 'Room closed');
        }
        room.subscribers.clear();

        this._rooms.delete(sessionId);
        this._log.info({ sessionId }, 'Room removed');
    }

    /**
     * Set the audio source (kiosk) for a room and connect to transcription service
     */
    setAudioSource(sessionId: string, socket: WebSocket): boolean {
        const room = this.getOrCreateRoom(sessionId);

        if (room.sourceSocket) {
            this._log.warn({ sessionId }, 'Room already has an audio source');
            return false;
        }

        room.sourceSocket = socket;

        // Create and connect transcription client using the room's session config
        const { providerKey, useSsl, sampleRate, numChannels } =
            room.transcriptionSessionConfig;

        const transcriptionClient = new TranscriptionStreamClient(
            this._transcriptionConfig.transcriptionServiceUrl,
            this._transcriptionConfig.transcriptionApiKey,
            useSsl,
            providerKey,
            { sample_rate: sampleRate, num_channels: numChannels },
        );

        // Wire up transcript events to fan out to subscribers
        transcriptionClient.on('ipTranscription', (text, starts, ends) => {
            this._broadcastToSubscribers(room, {
                type: 'ip_transcript',
                text,
                starts,
                ends,
            });
        });

        transcriptionClient.on('finalTranscription', (text, starts, ends) => {
            this._broadcastToSubscribers(room, {
                type: 'final_transcript',
                text,
                starts,
                ends,
            });
        });

        transcriptionClient.on('connected', () => {
            this._log.info({ sessionId }, 'Transcription service connected');
        });

        transcriptionClient.on('disconnected', (code, reason) => {
            this._log.info(
                { sessionId, code, reason },
                'Transcription service disconnected',
            );
        });

        transcriptionClient.on('error', (error) => {
            this._log.error(
                { sessionId, error: error.message },
                'Transcription service error',
            );
        });

        room.transcriptionClient = transcriptionClient;
        transcriptionClient.connect();

        this._log.info({ sessionId }, 'Audio source connected and transcription started');
        return true;
    }

    /**
     * Forward audio data from kiosk to transcription service
     */
    forwardAudio(sessionId: string, audioData: ArrayBufferLike | Buffer): void {
        const room = this._rooms.get(sessionId);
        if (!room?.transcriptionClient) return;

        room.transcriptionClient.send_audio(audioData);
    }

    /**
     * Remove audio source from a room
     */
    removeAudioSource(sessionId: string): void {
        const room = this._rooms.get(sessionId);
        if (!room) return;

        room.sourceSocket = null;

        // Disconnect transcription client when source leaves
        if (room.transcriptionClient) {
            room.transcriptionClient.disconnect();
            room.transcriptionClient = null;
        }

        this._log.info({ sessionId }, 'Audio source disconnected');

        // If no subscribers either, clean up the room
        if (room.subscribers.size === 0) {
            this.removeRoom(sessionId);
        }
    }

    /**
     * Add a transcript subscriber (student) to a room
     */
    addSubscriber(sessionId: string, socket: WebSocket): void {
        const room = this.getOrCreateRoom(sessionId);
        room.subscribers.add(socket);

        this._log.info(
            { sessionId, subscriberCount: room.subscribers.size },
            'Subscriber added to room',
        );
    }

    /**
     * Remove a transcript subscriber from a room
     */
    removeSubscriber(sessionId: string, socket: WebSocket): void {
        const room = this._rooms.get(sessionId);
        if (!room) return;

        room.subscribers.delete(socket);

        this._log.info(
            { sessionId, subscriberCount: room.subscribers.size },
            'Subscriber removed from room',
        );

        // If no source and no subscribers, clean up the room
        if (!room.sourceSocket && room.subscribers.size === 0) {
            this.removeRoom(sessionId);
        }
    }

    /**
     * List all active rooms
     */
    listRooms(): RoomInfo[] {
        const rooms: RoomInfo[] = [];
        for (const room of this._rooms.values()) {
            rooms.push({
                sessionId: room.sessionId,
                hasSource: room.sourceSocket !== null,
                subscriberCount: room.subscribers.size,
                createdAt: room.createdAt,
                transcriptionConnected: room.transcriptionClient !== null,
                transcriptionSessionConfig: room.transcriptionSessionConfig,
            });
        }
        return rooms;
    }

    /**
     * Get count of active rooms
     */
    getActiveRoomCount(): number {
        return this._rooms.size;
    }

    /**
     * Broadcast a message to all subscribers in a room
     */
    private _broadcastToSubscribers(room: Room, message: object): void {
        const data = JSON.stringify(message);
        for (const subscriber of room.subscribers) {
            if (subscriber.readyState === subscriber.OPEN) {
                subscriber.send(data);
            }
        }
    }
}
