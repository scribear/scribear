import { useEffect, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';

import type { Device } from '@scribear/session-manager-schema';

import { ActivationCodeDisplay } from '#src/components/activation-code-display';
import { ConfirmDialog } from '#src/components/confirm-dialog';
import type { ReregisterDeviceResult } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';

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
          <DialogContentText sx={{ mt: 2 }}>
            On the kiosk browser, open /kiosk and enter this code.
          </DialogContentText>
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

  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [misconfigured, setMisconfigured] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDialogKey, setRenameDialogKey] = useState(0);
  const [reregisterConfirmOpen, setReregisterConfirmOpen] = useState(false);
  const [reregistering, setReregistering] = useState(false);
  const [reregisterResult, setReregisterResult] =
    useState<ReregisterDeviceResult | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (deviceUid === undefined) return;
    const alive = { current: true };
    setLoading(true);
    setNotFound(false);
    setMisconfigured(false);
    adminApi
      .getDevice(deviceUid)
      .then((d) => {
        if (alive.current) setDevice(d);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          showError(errorMessage(err, 'Failed to load device.'));
        }
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceUid]);

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

  if (loading) {
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
        {device.name}
      </Typography>

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ minWidth: 100 }}
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
              color="text.secondary"
              sx={{ minWidth: 100 }}
            >
              Room
            </Typography>
            {device.roomUid === null ? (
              <Typography>Unassigned</Typography>
            ) : (
              <Link component={RouterLink} to={`/rooms/${device.roomUid}`}>
                {device.roomUid}
              </Link>
            )}
          </Box>
          <Divider />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ minWidth: 100 }}
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
        onRenamed={(updated) => {
          setDevice(updated);
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
