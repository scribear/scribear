import { useEffect } from 'react';

import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { CopyIconButton } from '#src/components/copy-icon-button';
import type { DemoRoomStatus } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { buildJoinUrl } from '#src/lib/join-url';
import { useAsyncData } from '#src/lib/use-async-data';

// Join codes rotate on a ~5 minute window server-side; re-poll well inside that
// so the "Open live captions" link stays exchangeable without a manual refresh.
const POLL_MS = 120_000;

type ChipColor = 'success' | 'warning' | 'default';

function statusChip(status: DemoRoomStatus): {
  label: string;
  color: ChipColor;
} {
  if (!status.enabled) return { label: 'Disabled', color: 'default' };
  if (!status.active) return { label: 'Not running', color: 'warning' };
  return { label: 'Running', color: 'success' };
}

/**
 * Dashboard card for the demo caption room. Shows whether the feature is
 * enabled and its seeded session is currently joinable, and — when it is — a
 * one-click link that opens the client webapp straight into the live captions
 * (no manual join-code entry). Also a forcing function for exercising the
 * client frontend end-to-end without a mic or source device.
 */
export const DemoRoomCard = () => {
  const { data, loading, reload } = useAsyncData<DemoRoomStatus>(
    () => adminApi.demoRoom(),
    [],
  );

  useEffect(() => {
    const id = window.setInterval(reload, POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [reload]);

  const chip = data ? statusChip(data) : null;
  const joinUrl =
    data?.active && data.joinCode !== null ? buildJoinUrl(data.joinCode) : null;

  return (
    <Box sx={{ mb: 3 }}>
      <Stack
        direction="row"
        sx={{
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Typography variant="h6" component="h2">
          Demo caption room
        </Typography>
        {chip && <Chip size="small" label={chip.label} color={chip.color} />}
      </Stack>
      <Card sx={{ maxWidth: 480 }}>
        <CardContent>
          {loading && data === null ? (
            <CircularProgress size={24} />
          ) : data === null ? (
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
              }}
            >
              Demo room status unavailable.
            </Typography>
          ) : !data.enabled ? (
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
              }}
            >
              Off — <code>DEMO_ROOM_ENABLED=false</code> is set on the Session
              Manager and Node Server. It runs by default; clear that flag to
              bring back the looping demo caption stream, which needs no
              microphone or source device.
            </Typography>
          ) : !data.active ? (
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
              }}
            >
              Enabled, but no joinable demo session was found yet — the seeder
              may still be starting, or seeding failed. Check the Session
              Manager logs.
            </Typography>
          ) : (
            <Stack spacing={1.5}>
              <Typography
                variant="body2"
                sx={{
                  color: 'text.secondary',
                }}
              >
                {data.roomName ?? 'Demo room'} is live. Open it to watch the
                looping captions in the client webapp — no join code entry
                needed.
              </Typography>
              <Stack
                direction="row"
                spacing={0.5}
                sx={{
                  alignItems: 'center',
                }}
              >
                {joinUrl !== null ? (
                  <Button
                    variant="contained"
                    startIcon={<OpenInNewIcon />}
                    component="a"
                    href={joinUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open live captions
                  </Button>
                ) : (
                  <Button
                    variant="contained"
                    startIcon={<OpenInNewIcon />}
                    disabled
                  >
                    Open live captions
                  </Button>
                )}
                {joinUrl !== null && (
                  <CopyIconButton value={joinUrl} label="join link" />
                )}
              </Stack>
              {data.joinCode !== null && (
                <Stack
                  direction="row"
                  spacing={0.5}
                  sx={{
                    alignItems: 'center',
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    Join code <strong>{data.joinCode}</strong> · rotates every
                    few minutes
                  </Typography>
                  <CopyIconButton value={data.joinCode} label="join code" />
                </Stack>
              )}
            </Stack>
          )}
        </CardContent>
      </Card>
    </Box>
  );
};
