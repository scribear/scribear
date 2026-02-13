/**
 * React hook that manages the kiosk-side audio pipeline:
 *   1. Opens browser microphone
 *   2. Captures PCM audio via AudioWorkletNode
 *   3. Down-samples to target rate and encodes as WAV chunks
 *   4. Streams chunks over a WebSocket to the node-server /audio/:sessionId
 *
 * Returns connection state and a disconnect function.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { NODE_SERVER_WS_URL } from '@/config/api-urls';

import { downsample, encodeWav } from './wav-encoder';

export type AudioSourceStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'error'
  | 'disconnected';

interface UseAudioSourceOptions {
  sessionId: string;
  token: string;
  sampleRate?: number;
  numChannels?: number;
}

interface UseAudioSourceReturn {
  status: AudioSourceStatus;
  error: string | null;
  disconnect: () => void;
}

// AudioWorklet processor that buffers samples and posts them to the main thread.
// Buffer size of 16000 = 1 second of audio at 16kHz after downsampling,
// producing ~2 chunks per job period (job_period_ms: 2000) instead of dozens
// of tiny chunks. Fewer, larger WAV files reduce decode overhead.
const PROCESSOR_CODE = `
class AudioChunkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._bufferSize = 16000;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      for (let i = 0; i < input[0].length; i++) {
        this._buffer.push(input[0][i]);
      }
      while (this._buffer.length >= this._bufferSize) {
        const chunk = new Float32Array(this._buffer.splice(0, this._bufferSize));
        this.port.postMessage(chunk, [chunk.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('audio-chunk-processor', AudioChunkProcessor);
`;

export function useAudioSource(
  options: UseAudioSourceOptions | null,
): UseAudioSourceReturn {
  const { sessionId, token, sampleRate = 16000, numChannels = 1 } =
    options ?? { sessionId: '', token: '' };

  const [status, setStatus] = useState<AudioSourceStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => {
        t.stop();
      });
      micStreamRef.current = null;
    }

    if (wsRef.current) {
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close(1000, 'Kiosk disconnecting');
      }
      wsRef.current = null;
    }
  }, []);

  const cancelledRef = useRef(false);

  useEffect(() => {
    // Don't connect if no options provided
    if (!options) return;

    cancelledRef.current = false;

    const start = async () => {
      try {
        // 1. Open microphone
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: numChannels,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        });
        if (cancelledRef.current) {
          micStream.getTracks().forEach((t) => {
            t.stop();
          });
          return;
        }
        micStreamRef.current = micStream;

        // 2. Set up AudioContext (browser picks its own native sample rate)
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;

        const nativeSampleRate = audioContext.sampleRate;
        const source = audioContext.createMediaStreamSource(micStream);

        // 3. Connect WebSocket to node-server
        const wsUrl = `${NODE_SERVER_WS_URL}/audio/${sessionId}?token=${token}`;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => {
            resolve();
          };
          ws.onerror = () => {
            reject(new Error('WebSocket connection failed'));
          };
          const timeout = setTimeout(() => {
            reject(new Error('WebSocket connection timeout'));
          }, 10_000);

          // Clean up timeout on success or failure
          const origOnOpen = ws.onopen;
          const origOnError = ws.onerror;
          ws.onopen = (ev) => {
            clearTimeout(timeout);
            (origOnOpen as (ev: Event) => void)(ev);
          };
          ws.onerror = (ev) => {
            clearTimeout(timeout);
            (origOnError as (ev: Event) => void)(ev);
          };
        });

        // Ref may be set to true by cleanup during the await above
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (cancelledRef.current) {
          cleanup();
          return;
        }

        // 4. Set up AudioWorklet for capturing PCM samples
        const blob = new Blob([PROCESSOR_CODE], {
          type: 'application/javascript',
        });
        const workletUrl = URL.createObjectURL(blob);
        await audioContext.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        // Ref may be set to true by cleanup during the await above
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (cancelledRef.current) {
          cleanup();
          return;
        }

        const workletNode = new AudioWorkletNode(
          audioContext,
          'audio-chunk-processor',
        );

        workletNode.port.onmessage = (event: MessageEvent) => {
          if (ws.readyState !== WebSocket.OPEN) return;

          const inputData = event.data as Float32Array;

          // Downsample if browser native rate differs from target
          const resampled =
            nativeSampleRate !== sampleRate
              ? downsample(inputData, nativeSampleRate, sampleRate)
              : inputData;

          // Encode as WAV and send
          const wavBuffer = encodeWav(resampled, sampleRate, numChannels);
          ws.send(wavBuffer);
        };

        source.connect(workletNode);
        workletNode.connect(audioContext.destination);

        setStatus('streaming');

        // Handle WebSocket close
        ws.onclose = (event) => {
          if (!cancelledRef.current) {
            setStatus('disconnected');
            if (event.code !== 1000) {
              setError(
                `Connection closed: ${event.reason || `code ${event.code.toString()}`}`,
              );
            }
          }
        };

        ws.onerror = () => {
          if (!cancelledRef.current) {
            setError('WebSocket error');
            setStatus('error');
          }
        };
      } catch (err) {
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setStatus('error');
        }
      }
    };

    void start();

    return () => {
      cancelledRef.current = true;
      cleanup();
    };
  }, [options, sessionId, token, sampleRate, numChannels, cleanup]);

  // Derive connecting status: when options are set but streaming hasn't started
  const derivedStatus =
    options && status === 'idle' ? 'connecting' : status;

  const disconnect = useCallback(() => {
    cleanup();
    setStatus('disconnected');
  }, [cleanup]);

  return { status: derivedStatus, error, disconnect };
}
