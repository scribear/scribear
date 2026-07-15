import { useEffect, useState } from 'react';

import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
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

import { useNavigate } from 'react-router-dom';

import type { Device, Room } from '@scribear/session-manager-schema';

import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';

const DEFAULT_TIMEZONE = 'America/Chicago';
const PAGE_LIMIT = 25;

interface CreateRoomDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

/**
 * Rendered only while the "New room" dialog should be open (the parent
 * mounts/unmounts it), so all local state initializes fresh via `useState`
 * literals rather than an effect-driven reset.
 */
const CreateRoomDialog = ({ onClose, onCreated }: CreateRoomDialogProps) => {
  const { showSuccess, showError } = useToast();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [sourceDeviceUid, setSourceDeviceUid] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  useEffect(() => {
    const alive = { current: true };
    adminApi
      .listDevices({ limit: 200 })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = () => {
    setSubmitting(true);
    setMisconfigured(false);
    adminApi
      .createRoom({
        name,
        timezone,
        autoSessionEnabled: false,
        sourceDeviceUids: [sourceDeviceUid],
      })
      .then(() => {
        showSuccess('Room created.');
        onCreated();
      })
      .catch((err: unknown) => {
        if (
          err instanceof ApiError &&
          err.code === 'BACKEND_MISCONFIGURATION'
        ) {
          setMisconfigured(true);
        } else {
          showError(
            err instanceof ApiError ? err.message : 'Failed to create room.',
          );
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const canSubmit =
    name.trim() !== '' && timezone.trim() !== '' && sourceDeviceUid !== '';

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>New room</DialogTitle>
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
        <TextField
          label="Timezone"
          value={timezone}
          onChange={(e) => {
            setTimezone(e.target.value);
          }}
          fullWidth
          margin="normal"
          helperText="IANA timezone identifier, e.g. America/Chicago"
        />
        <FormControl
          fullWidth
          margin="normal"
          disabled={devicesLoading || devices.length === 0}
        >
          <InputLabel id="create-room-source-device-label">
            Source device
          </InputLabel>
          <Select
            labelId="create-room-source-device-label"
            label="Source device"
            value={sourceDeviceUid}
            onChange={(e: SelectChangeEvent) => {
              setSourceDeviceUid(e.target.value);
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
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No devices are registered yet. Register a device before creating a
            room.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={!canSubmit || submitting}
        >
          {submitting ? 'Creating…' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export const RoomsListPage = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [search, setSearch] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  const load = (opts: { search: string; cursor?: string; append: boolean }) => {
    if (opts.append) setLoadingMore(true);
    else setLoading(true);
    const query: { search?: string; cursor?: string; limit: number } = {
      limit: PAGE_LIMIT,
    };
    if (opts.search !== '') query.search = opts.search;
    if (opts.cursor !== undefined) query.cursor = opts.cursor;
    adminApi
      .listRooms(query)
      .then((res) => {
        setMisconfigured(false);
        setRooms((prev) => (opts.append ? [...prev, ...res.items] : res.items));
        setNextCursor(res.nextCursor);
      })
      .catch((err: unknown) => {
        if (
          err instanceof ApiError &&
          err.code === 'BACKEND_MISCONFIGURATION'
        ) {
          setMisconfigured(true);
        } else {
          showError(
            err instanceof ApiError ? err.message : 'Failed to load rooms.',
          );
        }
      })
      .finally(() => {
        setLoading(false);
        setLoadingMore(false);
      });
  };

  useEffect(() => {
    const alive = { current: true };
    setLoading(true);
    const query: { search?: string; limit: number } = { limit: PAGE_LIMIT };
    if (search !== '') query.search = search;
    adminApi
      .listRooms(query)
      .then((res) => {
        if (!alive.current) return;
        setMisconfigured(false);
        setRooms(res.items);
        setNextCursor(res.nextCursor);
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
            err instanceof ApiError ? err.message : 'Failed to load rooms.',
          );
        }
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const handleLoadMore = () => {
    if (nextCursor === null) return;
    load({ search, cursor: nextCursor, append: true });
  };

  const handleCreated = () => {
    setCreateOpen(false);
    load({ search, append: false });
  };

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 2,
        }}
      >
        <Typography variant="h5" component="h1">
          Rooms
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          New room
        </Button>
      </Box>

      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}

      <TextField
        label="Search rooms"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
        }}
        fullWidth
        sx={{ mb: 2 }}
        size="small"
      />

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Timezone</TableCell>
              <TableCell>Auto-sessions</TableCell>
              <TableCell>Created</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={4} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            ) : rooms.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">
                    No rooms found.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              rooms.map((room) => (
                <TableRow
                  key={room.uid}
                  hover
                  onClick={() => {
                    void navigate(`/rooms/${room.uid}`);
                  }}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>{room.name}</TableCell>
                  <TableCell>{room.timezone}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={room.autoSessionEnabled ? 'Enabled' : 'Disabled'}
                      color={room.autoSessionEnabled ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell>
                    {new Date(room.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {nextCursor !== null && !loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </Box>
      )}

      {createOpen && (
        <CreateRoomDialog
          onClose={() => {
            setCreateOpen(false);
          }}
          onCreated={handleCreated}
        />
      )}
    </Box>
  );
};
