import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

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
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { canCancel, canEndEarly, canStartEarly } from '#src/lib/session-rules';
import { useToast } from '#src/lib/toast-context';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function formatDateTime(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

/** YYYY-MM-DD from an ISO instant, for the `?date=` calendar deep link. */
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
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

  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [misconfigured, setMisconfigured] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [startConfirmOpen, setStartConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = () => {
    if (sessionUid === undefined) return;
    setLoading(true);
    setNotFound(false);
    setMisconfigured(false);
    adminApi
      .getSession(sessionUid)
      .then((s) => {
        setSession(s);
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          showError(errorMessage(err, 'Failed to load session.'));
        }
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    if (sessionUid === undefined) return;
    const alive = { current: true };
    setLoading(true);
    setNotFound(false);
    setMisconfigured(false);
    adminApi
      .getSession(sessionUid)
      .then((s) => {
        if (alive.current) setSession(s);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          showError(errorMessage(err, 'Failed to load session.'));
        }
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUid]);

  const handleStartEarly = () => {
    if (sessionUid === undefined) return;
    setStarting(true);
    adminApi
      .startSessionEarly(sessionUid)
      .then(() => {
        showSuccess('Session started early.');
        load();
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to start session early.'));
        }
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
        load();
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to end session early.'));
        }
      })
      .finally(() => {
        setEnding(false);
        setEndConfirmOpen(false);
      });
  };

  const handleCancel = () => {
    if (sessionUid === undefined) return;
    setCancelling(true);
    adminApi
      .cancelSession(sessionUid)
      .then(() => {
        showSuccess('Session canceled.', {
          label: 'Undo',
          onClick: () => {
            adminApi
              .uncancelSession(sessionUid)
              .then(() => {
                showSuccess('Cancellation undone.');
                load();
              })
              .catch((err: unknown) => {
                if (isApiErrorCode(err, 'SLOT_NO_LONGER_AVAILABLE')) {
                  showError(
                    "Can't undo — another session now occupies this time.",
                  );
                } else {
                  showError(errorMessage(err, 'Failed to undo cancellation.'));
                }
              });
          },
        });
        load();
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to cancel session.'));
        }
      })
      .finally(() => {
        setCancelling(false);
        setCancelConfirmOpen(false);
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
        {session.canceledAt !== null && (
          <Chip size="small" label="Canceled" color="default" />
        )}
        <Link
          component={RouterLink}
          to={`/rooms/${session.roomUid}/calendar?date=${dateOnly(session.effectiveStart)}`}
          sx={{ ml: 'auto' }}
        >
          View in calendar
        </Link>
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
          {session.canceledAt !== null && (
            <>
              <Divider />
              <FieldRow label="Canceled at">
                <Typography>{formatDateTime(session.canceledAt)}</Typography>
              </FieldRow>
            </>
          )}
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

      <Stack direction="row" spacing={2}>
        {canStartEarly(session, new Date()) && (
          <Button
            variant="outlined"
            onClick={() => {
              setStartConfirmOpen(true);
            }}
          >
            Start early
          </Button>
        )}
        {canEndEarly(session, new Date()) && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => {
              setEndConfirmOpen(true);
            }}
          >
            End early
          </Button>
        )}
        {canCancel(session, new Date()) && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => {
              setCancelConfirmOpen(true);
            }}
          >
            Cancel session
          </Button>
        )}
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
        open={cancelConfirmOpen}
        title="Cancel session"
        message="This cancels this one occurrence. It does not affect the recurring schedule or any other occurrence. If a matching auto-session window covers this time, an auto-generated session may fill the gap. Editing or deleting the parent schedule later will also remove this cancellation."
        confirmLabel="Cancel session"
        confirmColor="error"
        loading={cancelling}
        onConfirm={handleCancel}
        onClose={() => {
          setCancelConfirmOpen(false);
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
