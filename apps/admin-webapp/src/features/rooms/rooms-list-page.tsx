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

import { DEMO_SOURCE_DEVICE_UID } from '@scribear/session-manager-schema';
import type { Device, Room } from '@scribear/session-manager-schema';

import { ErrorState } from '#src/components/error-state';
import { NameWithUid } from '#src/components/name-with-uid';
import { TimezoneNote } from '#src/components/timezone-note';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';
import { useSettings } from '#src/lib/settings-context';
import { useToast } from '#src/lib/toast-context';
import { useAsyncList } from '#src/lib/use-async-list';

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
        // The demo caption room's placeholder source device is never activated
        // and can never send audio, so create-room refuses it (409). Drop it
        // from the picker rather than offer a choice that always fails.
        if (alive.current) {
          setDevices(res.items.filter((d) => d.uid !== DEMO_SOURCE_DEVICE_UID));
        }
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
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
              mt: 1,
            }}
          >
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
  const { showUuids } = useSettings();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const { state, loadingMore, loadMoreError, hasMore, loadMore, reload } =
    useAsyncList<Room>(
      (cursor) => {
        const query: { search?: string; cursor?: string; limit: number } = {
          limit: PAGE_LIMIT,
        };
        if (search !== '') query.search = search;
        if (cursor !== undefined) query.cursor = cursor;
        return adminApi.listRooms(query);
      },
      [search],
    );

  const handleCreated = () => {
    setCreateOpen(false);
    reload();
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
      <TimezoneNote />
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
            {/* Three outcomes, never two: "No rooms found." is reachable only
                from `ok`, so a failed load can no longer state that the
                deployment has no rooms (PLAN-VisibleErrors §5). */}
            {state.status === 'loading' ? (
              <TableRow>
                <TableCell colSpan={4} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            ) : state.status === 'unavailable' ? (
              <TableRow>
                <TableCell colSpan={4} sx={{ py: 2 }}>
                  <ErrorState
                    title="Could not load rooms."
                    error={state.error}
                    onRetry={reload}
                  />
                </TableCell>
              </TableRow>
            ) : state.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No rooms found.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              state.items.map((room) => (
                <TableRow
                  key={room.uid}
                  hover
                  onClick={() => {
                    void navigate(`/rooms/${room.uid}`);
                  }}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    <NameWithUid
                      name={room.name}
                      uid={room.uid}
                      showUid={showUuids}
                    />
                  </TableCell>
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
      {loadMoreError !== null && (
        <ErrorState
          title="Could not load the next page of rooms."
          error={loadMoreError}
          onRetry={loadMore}
          sx={{ mt: 2 }}
        />
      )}
      {state.status === 'ok' && hasMore && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={loadMore} disabled={loadingMore}>
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
