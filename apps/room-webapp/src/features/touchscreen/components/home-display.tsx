import { useCallback, useRef, useState } from 'react';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CircleIcon from '@mui/icons-material/Circle';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';

import { RoomServiceStatus } from '#src/features/room-provider/services/room-service-status';
import {
  selectActiveSessionId,
  selectDeviceName,
} from '#src/features/room-provider/stores/room-config-slice';
import {
  selectRoomServiceStatus,
  selectUpcomingSessions,
} from '#src/features/room-provider/stores/room-service-slice';
import { useAppSelector } from '#src/store/use-redux';
import { ActiveSessionControls } from './active-session-controls';
import { DisplaySettingsPanel } from './display-settings-panel';
import { UpcomingSessionsList } from './upcoming-sessions-list';

const STATUS_COLOR: Record<string, 'success.main' | 'warning.main' | 'error.main' | 'text.disabled'> = {
  [RoomServiceStatus.ACTIVE]: 'success.main',
  [RoomServiceStatus.ACTIVE_MUTE]: 'success.main',
  [RoomServiceStatus.IDLE]: 'success.main',
  [RoomServiceStatus.SESSION_CONNECTING]: 'warning.main',
  [RoomServiceStatus.SESSION_ERROR]: 'warning.main',
  [RoomServiceStatus.ERROR]: 'error.main',
};

const STATUS_LABEL: Record<string, string> = {
  [RoomServiceStatus.ACTIVE]: 'Connected',
  [RoomServiceStatus.ACTIVE_MUTE]: 'Connected · Muted',
  [RoomServiceStatus.IDLE]: 'Connected',
  [RoomServiceStatus.SESSION_CONNECTING]: 'Connecting…',
  [RoomServiceStatus.SESSION_ERROR]: 'Connection Error',
  [RoomServiceStatus.ERROR]: 'Error',
};

const CARD_SX = {
  bgcolor: 'rgba(255,255,255,0.06)',
  borderRadius: 3,
  border: '1px solid rgba(255,255,255,0.08)',
  p: 2.5,
} as const;

const SPLIT_MIN = 20;
const SPLIT_MAX = 75;
const SPLIT_DEFAULT = 42;

export const HomeDisplay = () => {
  const deviceName = useAppSelector(selectDeviceName);
  const status = useAppSelector(selectRoomServiceStatus);
  const activeSessionId = useAppSelector(selectActiveSessionId);
  const upcomingSessions = useAppSelector(selectUpcomingSessions);

  const activeSession = activeSessionId
    ? (upcomingSessions.find((s) => s.sessionId === activeSessionId) ?? null)
    : null;

  const isInSession =
    status === RoomServiceStatus.SESSION_CONNECTING ||
    status === RoomServiceStatus.ACTIVE ||
    status === RoomServiceStatus.ACTIVE_MUTE ||
    status === RoomServiceStatus.SESSION_ERROR;

  const dotColor = STATUS_COLOR[status] ?? 'text.disabled';
  const statusLabel = STATUS_LABEL[status] ?? 'Disconnected';

  // ── Drag-to-resize state ──────────────────────────────────────────────
  const [splitPct, setSplitPct] = useState(SPLIT_DEFAULT);
  const bodyRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const onDividerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isDragging.current = true;
  }, []);

  const onDividerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current || !bodyRef.current) return;
    const rect = bodyRef.current.getBoundingClientRect();
    const raw = ((e.clientX - rect.left) / rect.width) * 100;
    setSplitPct(Math.min(Math.max(raw, SPLIT_MIN), SPLIT_MAX));
  }, []);

  const onDividerPointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        overflow: 'hidden',
      }}
    >
      {/* ── Header bar ── */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{
          px: 3,
          py: 1.5,
          flexShrink: 0,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <Typography variant="h5" fontWeight={700} letterSpacing={-0.5}>
          {deviceName ?? 'Room Display'}
        </Typography>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CircleIcon sx={{ fontSize: 10, color: dotColor }} />
          <Typography variant="body2" color="text.secondary">
            {statusLabel}
          </Typography>
        </Stack>
      </Stack>

      {/* ── Body ── */}
      {isInSession && !activeSessionId ? (
        /* Session connecting, no ID yet */
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Typography variant="h6" color="warning.main">
            Connecting to session…
          </Typography>
        </Box>
      ) : (
        /* Two-pane layout (in-session or idle) */
        <Box
          ref={bodyRef}
          sx={{
            flex: 1,
            display: 'flex',
            p: 2,
            gap: 0,
            overflow: 'hidden',
            userSelect: isDragging.current ? 'none' : 'auto',
          }}
        >
          {/* Left pane */}
          <Box
            sx={{
              ...CARD_SX,
              width: `${splitPct}%`,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {isInSession && activeSessionId ? (
              <ActiveSessionControls
                sessionId={activeSessionId}
                startTime={activeSession?.startTime ?? null}
                endTime={activeSession?.endTime ?? null}
                hasTimingInfo={activeSession !== null}
              />
            ) : (
              <Stack
                alignItems="center"
                justifyContent="center"
                sx={{ height: '100%' }}
                spacing={1}
              >
                <CircleIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
                <Typography variant="h6" fontWeight={600} textAlign="center">
                  No Active Session
                </Typography>
                <Typography variant="body2" color="text.secondary" textAlign="center">
                  Waiting for a session to start
                </Typography>
              </Stack>
            )}
          </Box>

          {/* Drag handle */}
          <Box
            sx={{
              width: 16,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'col-resize',
              color: 'rgba(255,255,255,0.18)',
              borderRadius: 1,
              mx: 0.5,
              transition: 'color 0.15s',
              '&:hover': { color: 'rgba(255,255,255,0.5)' },
              '&:active': { color: 'rgba(255,255,255,0.8)' },
            }}
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
            onPointerCancel={onDividerPointerUp}
          >
            <DragIndicatorIcon sx={{ fontSize: 18, pointerEvents: 'none' }} />
          </Box>

          {/* Right pane */}
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              minWidth: 0,
            }}
          >
            {isInSession && activeSessionId && (
              <Box sx={CARD_SX}>
                <DisplaySettingsPanel />
              </Box>
            )}
            <Box
              sx={{
                ...CARD_SX,
                flex: 1,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              }}
            >
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ letterSpacing: 1.5, mb: 1, flexShrink: 0 }}
              >
                Upcoming Sessions
              </Typography>
              <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                <UpcomingSessionsList />
              </Box>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
};
