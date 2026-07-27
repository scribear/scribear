import { useEffect, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';

import type { Device, Room } from '@scribear/session-manager-schema';

import { ActivationCodeDisplay } from '#src/components/activation-code-display';
import { ConfirmDialog } from '#src/components/confirm-dialog';
import { KioskUrlInstructions } from '#src/components/kiosk-url-instructions';
import { NameWithUid } from '#src/components/name-with-uid';
import type { ReregisterDeviceResult } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { useSettings } from '#src/lib/settings-context';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface RenameDeviceDialogProps {
  open: boolean;
  currentName: string;
  onClose: () => void;
  onRenamed: (device: Device) => void;
  deviceUid: string;
}

const RenameDeviceDialog = ({
  open,
  currentName,
  onClose,
  onRenamed,
  deviceUid,
}: RenameDeviceDialogProps) => {
  const { showSuccess, showError } = useToast();
  const [name, setName] = useState(currentName);
  const [submitting, setSubmitting] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  const handleSave = () => {
    setSubmitting(true);
    setMisconfigured(false);
    adminApi
      .updateDevice({ deviceUid, name })
      .then((device) => {
        showSuccess('Device renamed.');
        onRenamed(device);
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to rename device.'));
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Rename device</DialogTitle>
      <DialogContent>
        {misconfigured && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Admin backend misconfiguration — an operator must check the
            server&apos;s ADMIN_API_KEY.
          </Alert>
        )}
        <TextField
          label="Name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          fullWidth
          margin="normal"
          autoFocus
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={submitting || name.trim() === ''}
        >
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

interface ReregisterResultDialogProps {
  result: ReregisterDeviceResult | null;
  onClose: () => void;
}

const ReregisterResultDialog = ({
  result,
  onClose,
}: ReregisterResultDialogProps) => (
  <Dialog open={result !== null} onClose={onClose} maxWidth="xs" fullWidth>
    <DialogTitle>New activation code</DialogTitle>
    <DialogContent>
      {result && (
        <Box sx={{ mt: 1 }}>
          <ActivationCodeDisplay
            code={result.activationCode}
            expiry={result.expiry}
          />
          <KioskUrlInstructions />
        </Box>
      )}
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose} variant="contained">
        Done
      </Button>
    </DialogActions>
  </Dialog>
);

export const DeviceDetailPage = () => {
  const { deviceUid } = useParams<{ deviceUid: string }>();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const { showUuids } = useSettings();

  const {
    data: device,
    loading,
    error,
    reload,
  } = useAsyncData<Device>(
    () =>
      deviceUid === undefined
        ? Promise.reject(new ApiError('NOT_FOUND', 'No device id.', 404))
        : adminApi.getDevice(deviceUid),
    [deviceUid],
  );

  // Branches derived from the load error rather than stored as separate state.
  const misconfigured = isApiErrorCode(error, 'BACKEND_MISCONFIGURATION');
  const notFound = error instanceof ApiError && error.status === 404;

  // Non-critical room lookup: fetch failures leave `room` null so the UI falls
  // back to showing the raw room uid.
  const roomUid = device?.roomUid ?? null;
  const { data: room } = useAsyncData<Room | null>(
    () =>
      roomUid === null ? Promise.resolve(null) : adminApi.getRoom(roomUid),
    [roomUid],
  );

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDialogKey, setRenameDialogKey] = useState(0);
  const [reregisterConfirmOpen, setReregisterConfirmOpen] = useState(false);
  const [reregistering, setReregistering] = useState(false);
  const [reregisterResult, setReregisterResult] =
    useState<ReregisterDeviceResult | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Any load failure that isn't misconfiguration or not-found is surfaced as a
  // toast, once per error.
  useEffect(() => {
    if (
      error !== null &&
      !isApiErrorCode(error, 'BACKEND_MISCONFIGURATION') &&
      !(error instanceof ApiError && error.status === 404)
    ) {
      showError(errorMessage(error, 'Failed to load device.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [error]);

  const handleDelete = () => {
    if (deviceUid === undefined) return;
    setDeleting(true);
    adminApi
      .deleteDevice(deviceUid)
      .then(() => {
        showSuccess('Device deleted.');
        void navigate('/devices');
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE')) {
          showError(
            "Can't delete: this device is a room's source. Reassign the source first.",
          );
        } else {
          showError(errorMessage(err, 'Failed to delete device.'));
        }
      })
      .finally(() => {
        setDeleting(false);
        setDeleteConfirmOpen(false);
      });
  };

  const handleReregister = () => {
    if (deviceUid === undefined) return;
    setReregistering(true);
    adminApi
      .reregisterDevice(deviceUid)
      .then((r) => {
        showSuccess('Device re-registered.');
        setReregisterResult(r);
        setReregisterConfirmOpen(false);
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to re-register device.'));
      })
      .finally(() => {
        setReregistering(false);
      });
  };

  if (loading && device === null) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (misconfigured) {
    return (
      <Alert severity="error">
        Admin backend misconfiguration — an operator must check the
        server&apos;s ADMIN_API_KEY.
      </Alert>
    );
  }

  if (notFound || device === null) {
    return <Alert severity="warning">Device not found.</Alert>;
  }

  return (
    <Box>
      <Typography variant="h5" component="h1" gutterBottom>
        <NameWithUid name={device.name} uid={device.uid} showUid={showUuids} />
      </Typography>
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
                minWidth: 100,
              }}
            >
              Status
            </Typography>
            <Chip
              size="small"
              label={device.active ? 'Activated' : 'Pending'}
              color={device.active ? 'success' : 'warning'}
            />
            {device.isSource === true && (
              <Chip
                size="small"
                label="Source"
                color="info"
                variant="outlined"
              />
            )}
          </Box>
          <Divider />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
                minWidth: 100,
              }}
            >
              Room
            </Typography>
            {device.roomUid === null ? (
              <Typography>Unassigned</Typography>
            ) : (
              <Link component={RouterLink} to={`/rooms/${device.roomUid}`}>
                {room === null ? (
                  device.roomUid
                ) : (
                  <NameWithUid
                    name={room.name}
                    uid={device.roomUid}
                    showUid={showUuids}
                  />
                )}
              </Link>
            )}
          </Box>
          <Divider />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
                minWidth: 100,
              }}
            >
              Created
            </Typography>
            <Typography>
              {new Date(device.createdAt).toLocaleString()}
            </Typography>
          </Box>
        </Stack>
      </Paper>
      <Stack direction="row" spacing={2}>
        <Button
          variant="outlined"
          onClick={() => {
            setRenameDialogKey((k) => k + 1);
            setRenameOpen(true);
          }}
        >
          Rename
        </Button>
        <Button
          variant="outlined"
          onClick={() => {
            setReregisterConfirmOpen(true);
          }}
        >
          Re-register
        </Button>
        <Button
          variant="outlined"
          color="error"
          onClick={() => {
            setDeleteConfirmOpen(true);
          }}
        >
          Delete
        </Button>
      </Stack>
      <RenameDeviceDialog
        key={renameDialogKey}
        open={renameOpen}
        currentName={device.name}
        deviceUid={device.uid}
        onClose={() => {
          setRenameOpen(false);
        }}
        onRenamed={() => {
          reload();
          setRenameOpen(false);
        }}
      />
      <ConfirmDialog
        open={reregisterConfirmOpen}
        title="Re-register device"
        message="This invalidates the device's current credential."
        confirmLabel="Re-register"
        loading={reregistering}
        onConfirm={handleReregister}
        onClose={() => {
          setReregisterConfirmOpen(false);
        }}
      />
      <ReregisterResultDialog
        result={reregisterResult}
        onClose={() => {
          setReregisterResult(null);
        }}
      />
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Delete device"
        message="This permanently deletes the device. This cannot be undone."
        confirmLabel="Delete"
        confirmColor="error"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => {
          setDeleteConfirmOpen(false);
        }}
      />
    </Box>
  );
};
