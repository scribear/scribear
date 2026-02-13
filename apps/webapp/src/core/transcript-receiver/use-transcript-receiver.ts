/**
 * React hook that manages the client-side transcript WebSocket:
 *   1. Connects to node-server /transcription/:sessionId
 *   2. Parses ip_transcript and final_transcript messages
 *   3. Dispatches them into the transcription-content Redux slice
 *
 * Returns connection state and a disconnect function.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { NODE_SERVER_WS_URL } from '@/config/api-urls';
import {
  appendFinalizedTranscription,
  replaceInProgressTranscription,
} from '@/core/transcription-content/store/transcription-content-slice';
import { useAppDispatch } from '@/stores/use-redux';

export type TranscriptReceiverStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected';

interface TranscriptMessage {
  type: 'ip_transcript' | 'final_transcript';
  text: string[];
  starts: number[] | null;
  ends: number[] | null;
}

interface UseTranscriptReceiverOptions {
  sessionId: string;
  token: string;
}

interface UseTranscriptReceiverReturn {
  status: TranscriptReceiverStatus;
  error: string | null;
  disconnect: () => void;
}

export function useTranscriptReceiver(
  options: UseTranscriptReceiverOptions | null,
): UseTranscriptReceiverReturn {
  const dispatch = useAppDispatch();

  const [status, setStatus] = useState<TranscriptReceiverStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close(1000, 'Client disconnecting');
      }
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!options) return;

    const { sessionId, token } = options;
    let cancelled = false;

    const wsUrl = `${NODE_SERVER_WS_URL}/transcription/${sessionId}?token=${token}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (cancelled) return;
      setStatus('connected');
    };

    ws.onmessage = (event: MessageEvent) => {
      if (cancelled) return;

      try {
        const msg = JSON.parse(event.data as string) as TranscriptMessage;

        // Build sequence, only including starts/ends if present
        const sequence: { text: string[]; starts?: number[]; ends?: number[] } =
          { text: msg.text };
        if (msg.starts) sequence.starts = msg.starts;
        if (msg.ends) sequence.ends = msg.ends;

        switch (msg.type) {
          case 'final_transcript':
            dispatch(appendFinalizedTranscription(sequence));
            break;
          case 'ip_transcript':
            dispatch(replaceInProgressTranscription(sequence));
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      if (cancelled) return;
      setStatus('disconnected');
      if (event.code !== 1000) {
        setError(
          `Connection closed: ${event.reason || `code ${event.code.toString()}`}`,
        );
      }
    };

    ws.onerror = () => {
      if (cancelled) return;
      setError('WebSocket error');
      setStatus('error');
    };

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [options, dispatch, cleanup]);

  // Derive connecting status: when options are set but WS hasn't opened yet
  const derivedStatus =
    options && status === 'idle' ? 'connecting' : status;

  const disconnect = useCallback(() => {
    cleanup();
    setStatus('disconnected');
  }, [cleanup]);

  return { status: derivedStatus, error, disconnect };
}
