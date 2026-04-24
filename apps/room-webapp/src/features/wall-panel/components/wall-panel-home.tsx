import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import CircleIcon from '@mui/icons-material/Circle';
import CloseIcon from '@mui/icons-material/Close';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { QRCodeSVG } from 'qrcode.react';

import { RoomServiceStatus } from '#src/features/room-provider/services/room-service-status';
import {
  selectActiveSessionId,
  selectDeviceName,
} from '#src/features/room-provider/stores/room-config-slice';
import {
  muteToggle,
  selectIsMuted,
  selectJoinCode,
  selectRoomServiceStatus,
  selectUpcomingSessions,
} from '#src/features/room-provider/stores/room-service-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';
import { buildClientJoinUrl } from '#src/utils/client-join-url';

import { useNow } from '../hooks/use-now';
import {
  formatDateLong,
  formatTimeNumeric,
  formatTimeTwoDigit,
} from '../wall-panel-format';
import { RollingTranscription } from './rolling-transcription';
import { ScheduleSessionList } from './schedule-session-list';

const CARD = {
  bgcolor: 'rgba(255,255,255,0.035)',
  borderRadius: 2,
  border: '1px solid rgba(255,255,255,0.14)',
  overflow: 'hidden',
} as const;

const STATUS_DOT: Record<
  string,
  'success.main' | 'warning.main' | 'error.main' | 'text.disabled'
> = {
  [RoomServiceStatus.ACTIVE]: 'success.main',
  [RoomServiceStatus.ACTIVE_MUTE]: 'success.main',
  [RoomServiceStatus.IDLE]: 'success.main',
  [RoomServiceStatus.SESSION_CONNECTING]: 'warning.main',
  [RoomServiceStatus.SESSION_ERROR]: 'warning.main',
  [RoomServiceStatus.ERROR]: 'error.main',
};

/** Upper bound for QR edge length (px); sidebar width is usually the limit. */
const QR_CAP_PX = 560;
const QR_MIN_PX = 160;

function useQrSize(insetPx: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(QR_MIN_PX);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const w = Math.max(0, width - insetPx);
        const h = Math.max(0, height - insetPx);
        // Square QR must fit; use full width when height allows (typical sidebar).
        const side = Math.max(QR_MIN_PX, Math.min(QR_CAP_PX, w, h));
        setPx((p) => (p === side ? p : side));
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [insetPx]);

  return [ref, px] as const;
}

function LiveHeader() {
  const deviceName = useAppSelector(selectDeviceName);
  const status = useAppSelector(selectRoomServiceStatus);
  const now = useNow(1000);

  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      sx={{
        px: { xs: 2, sm: 2.5 },
        py: 1.5,
        flexShrink: 0,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        bgcolor: 'rgba(0,0,0,0.2)',
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.25}
        sx={{ minWidth: 0 }}
      >
        <CircleIcon
          sx={{
            fontSize: 10,
            color: STATUS_DOT[status] ?? 'text.disabled',
            flexShrink: 0,
          }}
        />
        <Typography
          variant="h6"
          fontWeight={700}
          noWrap
          sx={{ letterSpacing: -0.3 }}
        >
          {deviceName ?? 'Room'}
        </Typography>
      </Stack>
      <Typography
        variant="h4"
        fontWeight={700}
        sx={{ fontVariantNumeric: 'tabular-nums', letterSpacing: -0.5 }}
      >
        {formatTimeNumeric(now)}
      </Typography>
    </Stack>
  );
}

function ScheduleDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const sessions = useAppSelector(selectUpcomingSessions);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      slotProps={{
        paper: {
          sx: {
            bgcolor: 'background.default',
            backgroundImage: 'none',
            borderRadius: 2,
          },
        },
      }}
    >
      <DialogTitle sx={{ pb: 0.5, pr: 1 }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
        >
          <Typography variant="h6" fontWeight={700}>
            Today&apos;s schedule
          </Typography>
          <IconButton onClick={onClose} aria-label="Close" size="medium">
            <CloseIcon />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <ScheduleSessionList sessions={sessions} />
      </DialogContent>
    </Dialog>
  );
}

function JoinQrPanel() {
  const joinCode = useAppSelector(selectJoinCode);
  const [measureRef, qrSize] = useQrSize(16);

  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      sx={{
        height: '100%',
        width: '100%',
        p: { xs: 1.5, md: 2 },
        minHeight: 0,
        gap: { xs: 1.25, md: 1.5 },
      }}
    >
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{
          letterSpacing: 2,
          textAlign: 'center',
          flexShrink: 0,
          fontSize: '0.75rem',
          fontWeight: 600,
        }}
      >
        Scan to join
      </Typography>
      {joinCode ? (
        <>
          <Box
            ref={measureRef}
            sx={{
              flex: '1 1 55%',
              width: '100%',
              minHeight: { xs: 300, sm: 340, md: 380 },
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Box
              sx={{
                p: 0.75,
                bgcolor: '#fff',
                borderRadius: 2,
                lineHeight: 0,
                border: '2px solid rgba(255,255,255,0.2)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
              }}
            >
              <QRCodeSVG
                value={buildClientJoinUrl(joinCode)}
                size={qrSize}
                bgColor="#ffffff"
                fgColor="#000000"
                marginSize={3}
                level="L"
              />
            </Box>
          </Box>
          <Typography
            component="div"
            textAlign="center"
            fontFamily="monospace"
            fontWeight={800}
            sx={{
              flexShrink: 0,
              fontSize: { xs: '2.35rem', sm: '2.75rem', md: '3.1rem' },
              letterSpacing: { xs: 6, sm: 8, md: 10 },
              lineHeight: 1.05,
              wordBreak: 'break-all',
            }}
          >
            {joinCode}
          </Typography>
        </>
      ) : (
        <Stack
          alignItems="center"
          justifyContent="center"
          spacing={1}
          sx={{ flex: 1, py: 4 }}
        >
          <CircularProgress size={26} />
          <Typography variant="body2" color="text.secondary">
            Preparing join code…
          </Typography>
        </Stack>
      )}
    </Stack>
  );
}

const TILE = {
  minWidth: 0,
  borderRadius: 2.5,
  border: '2px solid rgba(255,255,255,0.45)',
  bgcolor: 'rgba(255,255,255,0.06)',
  boxShadow:
    'inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 18px rgba(0,0,0,0.55)',
  transition:
    'background-color 0.12s, border-color 0.12s, box-shadow 0.12s, transform 0.1s',
  '&:hover': {
    bgcolor: 'rgba(255,255,255,0.11)',
    borderColor: 'primary.main',
    boxShadow:
      'inset 0 1px 0 rgba(255,255,255,0.1), 0 0 0 2px rgba(255,255,255,0.35), 0 6px 22px rgba(0,0,0,0.6)',
  },
  '&:active': { transform: 'scale(0.98)' },
  '&:disabled': { opacity: 0.38, boxShadow: 'none' },
} as const;

function SessionTiles({ onOpenSchedule }: { onOpenSchedule: () => void }) {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectRoomServiceStatus);
  const isMuted = useAppSelector(selectIsMuted);
  const activeSessionId = useAppSelector(selectActiveSessionId);
  const upcoming = useAppSelector(selectUpcomingSessions);
  const now = useNow(15_000);

  const endMs =
    activeSessionId != null
      ? (upcoming.find((s) => s.sessionId === activeSessionId)?.endTime ?? null)
      : null;

  const live =
    activeSessionId != null &&
    (status === RoomServiceStatus.ACTIVE ||
      status === RoomServiceStatus.ACTIVE_MUTE);

  const schedulePreview = useMemo(() => {
    const sorted = [...upcoming].sort((a, b) => a.startTime - b.startTime);
    const later =
      activeSessionId != null
        ? sorted.filter((s) => s.sessionId !== activeSessionId)
        : sorted;
    return later.slice(0, 3);
  }, [upcoming, activeSessionId]);

  const endsLine =
    endMs != null && endMs > now
      ? `Ends ${formatTimeNumeric(endMs)}`
      : endMs != null
        ? `Ended ${formatTimeNumeric(endMs)}`
        : 'End time unavailable';

  return (
    <Stack
      direction="row"
      spacing={1.25}
      sx={{ width: '100%', alignItems: 'stretch' }}
    >
      <ButtonBase
        onClick={onOpenSchedule}
        focusRipple
        sx={{
          ...TILE,
          flex: '1.35 1 0',
          minHeight: { xs: 168, sm: 176 },
          py: 1.5,
          px: 1.25,
          display: 'block',
          textAlign: 'left',
        }}
        aria-label="Open schedule"
      >
        <Stack spacing={1.25} sx={{ width: '100%' }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <CalendarMonthIcon
              sx={{ fontSize: 28, color: 'primary.light', flexShrink: 0 }}
            />
            <Typography
              variant="subtitle1"
              fontWeight={700}
              sx={{
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1.2,
                flex: 1,
                minWidth: 0,
              }}
            >
              {endsLine}
            </Typography>
          </Stack>

          <Box
            sx={{
              borderTop: '1px solid rgba(255,255,255,0.1)',
              pt: 1,
            }}
          >
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                mb: 0.75,
                color: 'text.secondary',
                fontWeight: 600,
                letterSpacing: 0.06,
                textTransform: 'uppercase',
                fontSize: '0.65rem',
              }}
            >
              Later today
            </Typography>
            {schedulePreview.length === 0 ? (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ lineHeight: 1.4 }}
              >
                Nothing else scheduled
              </Typography>
            ) : (
              <Stack spacing={0.5}>
                {schedulePreview.map((s) => {
                  const range =
                    s.endTime != null
                      ? `${formatTimeTwoDigit(s.startTime)} \u2013 ${formatTimeTwoDigit(s.endTime)}`
                      : formatTimeTwoDigit(s.startTime);
                  return (
                    <Typography
                      key={s.sessionId}
                      variant="body2"
                      noWrap
                      sx={{
                        fontVariantNumeric: 'tabular-nums',
                        fontSize: '0.8125rem',
                        lineHeight: 1.45,
                        color: 'rgba(255,255,255,0.82)',
                      }}
                    >
                      {range}
                    </Typography>
                  );
                })}
              </Stack>
            )}
          </Box>
        </Stack>
      </ButtonBase>

      <ButtonBase
        disabled={!live}
        onClick={() => dispatch(muteToggle(!isMuted))}
        focusRipple
        sx={{
          ...TILE,
          flex: '1 1 0',
          minHeight: { xs: 168, sm: 176 },
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderColor: isMuted ? 'error.light' : 'rgba(255,255,255,0.45)',
          bgcolor: isMuted
            ? 'rgba(244, 67, 54, 0.14)'
            : 'rgba(255,255,255,0.06)',
        }}
        aria-label={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? (
          <MicOffIcon sx={{ fontSize: 52, color: 'error.light' }} />
        ) : (
          <MicIcon sx={{ fontSize: 52, color: 'primary.light' }} />
        )}
      </ButtonBase>
    </Stack>
  );
}

function IdleView() {
  const deviceName = useAppSelector(selectDeviceName);
  const sessions = useAppSelector(selectUpcomingSessions);
  const now = useNow(1000);

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: { xs: 'column', md: 'row' },
        bgcolor: 'background.default',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          flex: { xs: '0 0 auto', md: '0 0 40%' },
          borderBottom: { xs: '1px solid rgba(255,255,255,0.08)', md: 'none' },
          borderRight: { md: '1px solid rgba(255,255,255,0.08)' },
          p: { xs: 2.5, md: 3 },
          display: 'flex',
          flexDirection: 'column',
          minHeight: { xs: '36vh', md: 0 },
          bgcolor: 'rgba(0,0,0,0.15)',
        }}
      >
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <CircleIcon sx={{ fontSize: 10, color: 'success.main' }} />
          <Typography variant="subtitle1" fontWeight={700} noWrap>
            {deviceName ?? 'Room'}
          </Typography>
        </Stack>
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          <Typography
            variant="h2"
            fontWeight={700}
            sx={{
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1.05,
              letterSpacing: -2,
              fontSize: { xs: '2.75rem', sm: '3.25rem', md: '4rem' },
            }}
          >
            {formatTimeNumeric(now)}
          </Typography>
          <Typography
            variant="h6"
            color="text.secondary"
            sx={{ mt: 1, fontWeight: 400 }}
          >
            {formatDateLong(now)}
          </Typography>
        </Box>
      </Box>

      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          p: { xs: 2, md: 2.5 },
        }}
      >
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ letterSpacing: 2 }}
        >
          Today
        </Typography>
        <Typography variant="h6" fontWeight={700} sx={{ mb: 1.5 }}>
          Upcoming sessions
        </Typography>
        <ScheduleSessionList sessions={sessions} />
      </Box>
    </Box>
  );
}

export const WallPanelHome = () => {
  const activeSessionId = useAppSelector(selectActiveSessionId);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  if (!activeSessionId) {
    return <IdleView />;
  }

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <LiveHeader />
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          gap: { xs: 1.25, md: 1.75 },
          p: { xs: 1.25, md: 1.75 },
          minHeight: 0,
        }}
      >
        <Box
          sx={{
            ...CARD,
            flex: { xs: '1 1 auto', md: '1 1 38%' },
            minHeight: { xs: 200, md: 0 },
            maxHeight: { md: '100%' },
            order: { xs: 2, md: 1 },
          }}
        >
          <RollingTranscription />
        </Box>
        <Stack
          spacing={1.25}
          sx={{
            flex: { xs: '1 1 62%', md: '1 1 62%' },
            minWidth: { xs: 0, md: 360 },
            maxWidth: { md: 560 },
            order: { xs: 1, md: 2 },
            minHeight: 0,
          }}
        >
          <Box
            sx={{
              ...CARD,
              flex: { xs: '1 1 auto', md: 1 },
              flexShrink: { xs: 1, md: 1 },
              minHeight: { xs: 420, md: 480 },
            }}
          >
            <JoinQrPanel />
          </Box>
          <Box sx={{ flexShrink: 0 }}>
            <SessionTiles
              onOpenSchedule={() => {
                setScheduleOpen(true);
              }}
            />
          </Box>
        </Stack>
      </Box>
      <ScheduleDialog
        open={scheduleOpen}
        onClose={() => {
          setScheduleOpen(false);
        }}
      />
    </Box>
  );
};
