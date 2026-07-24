import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { Link as RouterLink, useParams } from 'react-router-dom';

import type { Session } from '@scribear/session-manager-schema';

import { ConfirmDialog } from '#src/components/confirm-dialog';
import { CopyIconButton } from '#src/components/copy-icon-button';
import type { SessionJoinCodeStatus } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { buildJoinUrl } from '#src/lib/join-url';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

// Join codes rotate on a ~5 minute window server-side; re-poll well inside
// that so the "Open live captions" link stays exchangeable without a manual
// page refresh — mirrors the demo-room card's poll cadence.
const JOIN_CODE_POLL_MS = 120_000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function formatDateTime(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

interface FieldRowProps {
  label: string;
  children: ReactNode;
}

const FieldRow = ({ label, children }: FieldRowProps) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
    <Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
      {label}
    </Typography>
    {children}
  </Box>
);

export const SessionDetailPage = () => {
  const { sessionUid } = useParams<{ sessionUid: string }>();
  const { showSuccess, showError } = useToast();

  const {
    data: session,
    loading,
    error,
    reload,
  } = useAsyncData<Session>(
    () =>
      sessionUid === undefined
        ? Promise.reject(new ApiError('NOT_FOUND', 'No session id.', 404))
        : adminApi.getSession(sessionUid),
    [sessionUid],
  );

  // Branches derived from the load error rather than stored as separate state.
  const misconfigured = isApiErrorCode(error, 'BACKEND_MISCONFIGURATION');
  const notFound = error instanceof ApiError && error.status === 404;

  // Loaded independently of `session`: a failure here (or the session having
  // no join code yet) must not block the rest of the page, which already
  // renders fine from the primary load above.
  const { data: joinCodeStatus, reload: reloadJoinCode } =
    useAsyncData<SessionJoinCodeStatus>(
      () =>
        sessionUid === undefined
          ? Promise.reject(new ApiError('NOT_FOUND', 'No session id.', 404))
          : adminApi.getSessionJoinCode(sessionUid),
      [sessionUid],
    );

  useEffect(() => {
    const id = window.setInterval(reloadJoinCode, JOIN_CODE_POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [reloadJoinCode]);

  // `SessionJoinCodeStatus` isn't a true discriminated union (`joinCode`'s
  // nullability isn't tied to `status` in the type), so narrow explicitly
  // rather than asserting non-null in the JSX below.
  const joinCode =
    joinCodeStatus !== null &&
    joinCodeStatus.status === 'ok' &&
    joinCodeStatus.joinCode !== null
      ? joinCodeStatus.joinCode
      : null;
  const sessionJoinUrl = joinCode !== null ? buildJoinUrl(joinCode) : null;

  const [startConfirmOpen, setStartConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [ending, setEnding] = useState(false);

  // Any load failure that isn't misconfiguration or not-found is surfaced as a
  // toast, once per error.
  useEffect(() => {
    if (
      error !== null &&
      !isApiErrorCode(error, 'BACKEND_MISCONFIGURATION') &&
      !(error instanceof ApiError && error.status === 404)
    ) {
      showError(errorMessage(error, 'Failed to load session.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [error]);

  const handleStartEarly = () => {
    if (sessionUid === undefined) return;
    setStarting(true);
    adminApi
      .startSessionEarly(sessionUid)
      .then(() => {
        showSuccess('Session started early.');
        reload();
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to start session early.'));
      })
      .finally(() => {
        setStarting(false);
        setStartConfirmOpen(false);
      });
  };

  const handleEndEarly = () => {
    if (sessionUid === undefined) return;
    setEnding(true);
    adminApi
      .endSessionEarly(sessionUid)
      .then(() => {
        showSuccess('Session ended early.');
        reload();
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to end session early.'));
      })
      .finally(() => {
        setEnding(false);
        setEndConfirmOpen(false);
      });
  };

  if (loading && session === null) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (misconfigured && session === null) {
    return (
      <Alert severity="error">
        Admin backend misconfiguration — an operator must check the
        server&apos;s ADMIN_API_KEY.
      </Alert>
    );
  }

  if (notFound || session === null) {
    return <Alert severity="warning">Session not found.</Alert>;
  }

  return (
    <Box>
      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <Typography variant="h5" component="h1">
          {session.name}
        </Typography>
        <Chip
          size="small"
          label={session.type}
          color="primary"
          variant="outlined"
        />
      </Box>

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <FieldRow label="Room">
            <Link component={RouterLink} to={`/rooms/${session.roomUid}`}>
              {session.roomUid}
            </Link>
          </FieldRow>
          <Divider />
          <FieldRow label="Scheduled start">
            <Typography>
              {formatDateTime(session.scheduledStartTime)}
            </Typography>
          </FieldRow>
          <Divider />
          <FieldRow label="Scheduled end">
            <Typography>{formatDateTime(session.scheduledEndTime)}</Typography>
          </FieldRow>
          <Divider />
          <FieldRow label="Effective start">
            <Typography>{formatDateTime(session.effectiveStart)}</Typography>
          </FieldRow>
          <Divider />
          <FieldRow label="Effective end">
            <Typography>{formatDateTime(session.effectiveEnd)}</Typography>
          </FieldRow>
          <Divider />
          <FieldRow label="Join code scopes">
            <Stack direction="row" spacing={1}>
              {session.joinCodeScopes.map((scope) => (
                <Chip key={scope} size="small" label={scope} />
              ))}
            </Stack>
          </FieldRow>
          <Divider />
          <FieldRow label="Transcription provider">
            <Typography>{session.transcriptionProviderId}</Typography>
          </FieldRow>
          <Divider />
          <FieldRow label="Created">
            <Typography>{formatDateTime(session.createdAt)}</Typography>
          </FieldRow>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
          Join session
        </Typography>
        {joinCodeStatus === null ? (
          <Typography variant="body2" color="text.secondary">
            Join code unavailable.
          </Typography>
        ) : joinCodeStatus.status === 'no-join-scopes' ? (
          <Typography variant="body2" color="text.secondary">
            No join code scopes configured for this session.
          </Typography>
        ) : joinCodeStatus.status === 'not-active' ||
          joinCode === null ||
          sessionJoinUrl === null ? (
          <Typography variant="body2" color="text.secondary">
            Session is not currently active — no join code available.
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <Button
                variant="contained"
                startIcon={<OpenInNewIcon />}
                component="a"
                href={sessionJoinUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open live captions
              </Button>
              <CopyIconButton value={sessionJoinUrl} label="join link" />
            </Stack>
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <Typography variant="body2" color="text.secondary">
                Join code <strong>{joinCode}</strong> · rotates every few
                minutes
              </Typography>
              <CopyIconButton value={joinCode} label="join code" />
            </Stack>
          </Stack>
        )}
      </Paper>

      <Stack direction="row" spacing={2}>
        <Button
          variant="outlined"
          onClick={() => {
            setStartConfirmOpen(true);
          }}
        >
          Start early
        </Button>
        <Button
          variant="outlined"
          color="error"
          onClick={() => {
            setEndConfirmOpen(true);
          }}
        >
          End early
        </Button>
      </Stack>

      <ConfirmDialog
        open={startConfirmOpen}
        title="Start session early"
        message="This starts the session now, ahead of its scheduled start time."
        confirmLabel="Start early"
        loading={starting}
        onConfirm={handleStartEarly}
        onClose={() => {
          setStartConfirmOpen(false);
        }}
      />

      <ConfirmDialog
        open={endConfirmOpen}
        title="End session early"
        message="This ends the session now, ahead of its scheduled end time."
        confirmLabel="End early"
        confirmColor="error"
        loading={ending}
        onConfirm={handleEndEarly}
        onClose={() => {
          setEndConfirmOpen(false);
        }}
      />
    </Box>
  );
};
