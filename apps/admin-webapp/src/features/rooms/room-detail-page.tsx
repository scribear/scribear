import { useEffect, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useNavigate, useParams } from 'react-router-dom';

import { DEMO_ROOM_UID } from '@scribear/session-manager-schema';
import type { Device, Room } from '@scribear/session-manager-schema';

import { ConfirmDialog } from '#src/components/confirm-dialog';
import { NameWithUid } from '#src/components/name-with-uid';
import type { RoomDetail } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { useSettings } from '#src/lib/settings-context';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

interface RenameRoomDialogProps {
  room: Room;
  onClose: () => void;
  onRenamed: () => void;
}

/**
 * Rendered only while the rename dialog should be open (the parent
 * mounts/unmounts it), so `name` initializes fresh from `room.name` via a
 * `useState` literal rather than an effect-driven reset.
 */
const RenameRoomDialog = ({
  room,
  onClose,
  onRenamed,
}: RenameRoomDialogProps) => {
  const { showSuccess, showError } = useToast();
  const [name, setName] = useState(room.name);
  const [submitting, setSubmitting] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  const handleSubmit = () => {
    setSubmitting(true);
    setMisconfigured(false);
    adminApi
      .updateRoom({ roomUid: room.uid, name })
      .then(() => {
        showSuccess('Room renamed.');
        onRenamed();
      })
      .catch((err: unknown) => {
        if (
          err instanceof ApiError &&
          err.code === 'BACKEND_MISCONFIGURATION'
        ) {
          setMisconfigured(true);
        } else {
          showError(
            err instanceof ApiError ? err.message : 'Failed to rename room.',
          );
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Rename room</DialogTitle>
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
          onClick={handleSubmit}
          variant="contained"
          disabled={submitting || name.trim() === ''}
        >
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

interface AddDeviceDialogProps {
  roomUid: string;
  onClose: () => void;
  onAdded: () => void;
}

/**
 * Rendered only while the "Add device" dialog should be open (the parent
 * mounts/unmounts it), so local form state initializes fresh via `useState`
 * literals rather than an effect-driven reset.
 */
const AddDeviceDialog = ({
  roomUid,
  onClose,
  onAdded,
}: AddDeviceDialogProps) => {
  const { showSuccess, showError } = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [deviceUid, setDeviceUid] = useState('');
  const [asSource, setAsSource] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  useEffect(() => {
    const alive = { current: true };
    adminApi
      .listDevices({ roomUid: '', limit: 200 })
      .then((res) => {
        if (alive.current) setDevices(res.items);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (
          err instanceof ApiError &&
          err.code === 'BACKEND_MISCONFIGURATION'
        ) {
          setMisconfigured(true);
        } else {
          showError(
            err instanceof ApiError ? err.message : 'Failed to load devices.',
          );
        }
      })
      .finally(() => {
        if (alive.current) setDevicesLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, []);

  const handleSubmit = () => {
    setSubmitting(true);
    setMisconfigured(false);
    adminApi
      .addDeviceToRoom({ roomUid, deviceUid, asSource })
      .then(() => {
        showSuccess('Device added to room.');
        onAdded();
      })
      .catch((err: unknown) => {
        if (
          err instanceof ApiError &&
          err.code === 'BACKEND_MISCONFIGURATION'
        ) {
          setMisconfigured(true);
        } else {
          showError(
            err instanceof ApiError ? err.message : 'Failed to add device.',
          );
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Add device</DialogTitle>
      <DialogContent>
        {misconfigured && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Admin backend misconfiguration — an operator must check the
            server&apos;s ADMIN_API_KEY.
          </Alert>
        )}
        <FormControl
          fullWidth
          margin="normal"
          disabled={devicesLoading || devices.length === 0}
        >
          <InputLabel id="add-device-select-label">Device</InputLabel>
          <Select
            labelId="add-device-select-label"
            label="Device"
            value={deviceUid}
            onChange={(e: SelectChangeEvent) => {
              setDeviceUid(e.target.value);
            }}
          >
            {devices.map((d) => (
              <MenuItem key={d.uid} value={d.uid}>
                {d.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {!devicesLoading && devices.length === 0 && (
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
              mt: 1,
            }}
          >
            No unassigned devices are available.
          </Typography>
        )}
        <FormControlLabel
          control={
            <Checkbox
              checked={asSource}
              onChange={(e) => {
                setAsSource(e.target.checked);
              }}
            />
          }
          label="Add as source device"
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={submitting || deviceUid === ''}
        >
          {submitting ? 'Adding…' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export const RoomDetailPage = () => {
  const { roomUid } = useParams<{ roomUid: string }>();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const { showUuids } = useSettings();

  const {
    data: detail,
    loading,
    error,
    reload,
  } = useAsyncData<RoomDetail>(
    () =>
      roomUid === undefined
        ? Promise.reject(new ApiError('NOT_FOUND', 'No room id.', 404))
        : adminApi.roomDetail(roomUid),
    [roomUid],
  );

  // Derived from the load error rather than stored as separate state.
  const misconfigured = isApiErrorCode(error, 'BACKEND_MISCONFIGURATION');

  const [renameOpen, setRenameOpen] = useState(false);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rowActionUid, setRowActionUid] = useState<string | null>(null);

  // Non-misconfiguration load failures are surfaced as a toast, once per error.
  useEffect(() => {
    if (error !== null && !isApiErrorCode(error, 'BACKEND_MISCONFIGURATION')) {
      showError(
        error instanceof ApiError ? error.message : 'Failed to load room.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [error]);

  const handleSetSource = (deviceUid: string) => {
    if (roomUid === undefined) return;
    setRowActionUid(deviceUid);
    adminApi
      .setSourceDevice({ roomUid, deviceUid })
      .then(() => {
        showSuccess('Source device updated.');
        reload();
      })
      .catch((err: unknown) => {
        showError(
          err instanceof ApiError
            ? err.message
            : 'Failed to set source device.',
        );
      })
      .finally(() => {
        setRowActionUid(null);
      });
  };

  const handleRemoveDevice = (deviceUid: string) => {
    setRowActionUid(deviceUid);
    adminApi
      .removeDeviceFromRoom(deviceUid)
      .then(() => {
        showSuccess('Device removed from room.');
        reload();
      })
      .catch((err: unknown) => {
        showError(
          err instanceof ApiError ? err.message : 'Failed to remove device.',
        );
      })
      .finally(() => {
        setRowActionUid(null);
      });
  };

  const handleDelete = () => {
    if (roomUid === undefined) return;
    setDeleting(true);
    adminApi
      .deleteRoom(roomUid)
      .then(() => {
        showSuccess('Room deleted.');
        void navigate('/rooms');
      })
      .catch((err: unknown) => {
        showError(
          err instanceof ApiError ? err.message : 'Failed to delete room.',
        );
      })
      .finally(() => {
        setDeleting(false);
        setDeleteOpen(false);
      });
  };

  if (loading && !detail) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!detail) {
    return misconfigured ? (
      <Alert severity="error">
        Admin backend misconfiguration — an operator must check the
        server&apos;s ADMIN_API_KEY.
      </Alert>
    ) : (
      <Typography
        sx={{
          color: 'text.secondary',
        }}
      >
        Room not found.
      </Typography>
    );
  }

  const { room, devices } = detail;

  // The demo caption room emits a fixture caption stream and has no audio path,
  // so the Session Manager refuses to attach a device to it or to change its
  // source device. Disabling the controls here means an operator reads *why*
  // instead of discovering it by hitting a 409 — the rule is a permanent
  // property of this room, not a transient failure. "Remove" stays enabled: the
  // server still allows detaching a non-source device, which is the only way to
  // clean up a device attached before the refusal existed.
  const isDemoRoom = room.uid === DEMO_ROOM_UID;

  return (
    <Box>
      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 2,
        }}
      >
        <Typography variant="h5" component="h1">
          <NameWithUid name={room.name} uid={room.uid} showUid={showUuids} />
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            onClick={() => {
              void navigate(`/rooms/${room.uid}/scheduling`);
            }}
          >
            Manage scheduling
          </Button>
          <Button
            variant="outlined"
            onClick={() => {
              setRenameOpen(true);
            }}
          >
            Rename
          </Button>
          <Button
            variant="outlined"
            color="error"
            onClick={() => {
              setDeleteOpen(true);
            }}
          >
            Delete room
          </Button>
        </Box>
      </Box>
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 4 }}>
              <Typography
                variant="body2"
                sx={{
                  color: 'text.secondary',
                }}
              >
                Timezone
              </Typography>
              <Typography variant="body1">{room.timezone}</Typography>
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }}>
              <Typography
                variant="body2"
                sx={{
                  color: 'text.secondary',
                }}
              >
                Auto-sessions
              </Typography>
              <Chip
                size="small"
                label={room.autoSessionEnabled ? 'Enabled' : 'Disabled'}
                color={room.autoSessionEnabled ? 'success' : 'default'}
                variant="outlined"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }}>
              <Typography
                variant="body2"
                sx={{
                  color: 'text.secondary',
                }}
              >
                Created
              </Typography>
              <Typography variant="body1">
                {new Date(room.createdAt).toLocaleString()}
              </Typography>
            </Grid>
          </Grid>
        </CardContent>
      </Card>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Typography variant="h6" component="h2">
          Devices
        </Typography>
        <Button
          variant="contained"
          disabled={isDemoRoom}
          onClick={() => {
            setAddDeviceOpen(true);
          }}
        >
          Add device
        </Button>
      </Box>
      {isDemoRoom && (
        <Alert severity="info" sx={{ mb: 1 }}>
          This is the demo caption room. Its captions come from a fixture, not
          from a microphone — there is no audio path — so devices cannot be
          added to it and its source device cannot be changed.
        </Alert>
      )}
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Role</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {devices.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No devices assigned to this room.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              devices.map((device) => (
                <TableRow key={device.uid}>
                  <TableCell>
                    <NameWithUid
                      name={device.name}
                      uid={device.uid}
                      showUid={showUuids}
                    />
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={device.active ? 'Active' : 'Pending'}
                      color={device.active ? 'success' : 'warning'}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell>
                    {device.isSource === true ? (
                      <Chip size="small" label="Source" color="primary" />
                    ) : (
                      <Typography
                        variant="body2"
                        sx={{
                          color: 'text.secondary',
                        }}
                      >
                        —
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Box
                      sx={{
                        display: 'flex',
                        gap: 1,
                        justifyContent: 'flex-end',
                      }}
                    >
                      {device.isSource !== true && (
                        <Button
                          size="small"
                          disabled={rowActionUid === device.uid || isDemoRoom}
                          onClick={() => {
                            handleSetSource(device.uid);
                          }}
                        >
                          Set as source
                        </Button>
                      )}
                      <Button
                        size="small"
                        color="error"
                        disabled={rowActionUid === device.uid}
                        onClick={() => {
                          handleRemoveDevice(device.uid);
                        }}
                      >
                        Remove
                      </Button>
                    </Box>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {renameOpen && (
        <RenameRoomDialog
          room={room}
          onClose={() => {
            setRenameOpen(false);
          }}
          onRenamed={() => {
            setRenameOpen(false);
            reload();
          }}
        />
      )}
      {addDeviceOpen && (
        <AddDeviceDialog
          roomUid={room.uid}
          onClose={() => {
            setAddDeviceOpen(false);
          }}
          onAdded={() => {
            setAddDeviceOpen(false);
            reload();
          }}
        />
      )}
      <ConfirmDialog
        open={deleteOpen}
        title="Delete room"
        message="This deletes the room and its schedules/sessions/memberships."
        confirmLabel="Delete"
        confirmColor="error"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => {
          setDeleteOpen(false);
        }}
      />
    </Box>
  );
};
