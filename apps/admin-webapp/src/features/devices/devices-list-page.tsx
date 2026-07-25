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
import DialogContentText from '@mui/material/DialogContentText';
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
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { useNavigate } from 'react-router-dom';

import type { Device } from '@scribear/session-manager-schema';

import { ActivationCodeDisplay } from '#src/components/activation-code-display';
import { NameWithUid } from '#src/components/name-with-uid';
import type { RegisterDeviceResult } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { useSettings } from '#src/lib/settings-context';
import { useToast } from '#src/lib/toast-context';
import { useAsyncList } from '#src/lib/use-async-list';
import { useRoomNameLookup } from '#src/lib/use-room-name-lookup';

const PAGE_LIMIT = 25;

type StatusFilter = 'all' | 'active' | 'pending';
type RoomFilter = 'all' | 'unassigned';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface RegisterDeviceDialogProps {
  open: boolean;
  onClose: () => void;
  onRegistered: () => void;
}

/**
 * "Register device" dialog. Step 1 collects a name; on success it stays open
 * showing the activation code until the operator dismisses it, so they have
 * time to type the code on the kiosk.
 */
const RegisterDeviceDialog = ({
  open,
  onClose,
  onRegistered,
}: RegisterDeviceDialogProps) => {
  const { showSuccess, showError } = useToast();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);
  const [result, setResult] = useState<RegisterDeviceResult | null>(null);

  const handleRegister = () => {
    setSubmitting(true);
    setMisconfigured(false);
    adminApi
      .registerDevice(name)
      .then((r) => {
        setResult(r);
        showSuccess('Device registered.');
        onRegistered();
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to register device.'));
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const handleClose = () => {
    setResult(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>Register device</DialogTitle>
      <DialogContent>
        {misconfigured && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Admin backend misconfiguration — an operator must check the
            server&apos;s ADMIN_API_KEY.
          </Alert>
        )}
        {result ? (
          <Box sx={{ mt: 1 }}>
            <ActivationCodeDisplay
              code={result.activationCode}
              expiry={result.expiry}
            />
            <DialogContentText sx={{ mt: 2 }}>
              On the kiosk browser, open /kiosk and enter this code.
            </DialogContentText>
          </Box>
        ) : (
          <TextField
            label="Device name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            fullWidth
            margin="normal"
            autoFocus
          />
        )}
      </DialogContent>
      <DialogActions>
        {result ? (
          <Button onClick={handleClose} variant="contained">
            Done
          </Button>
        ) : (
          <>
            <Button onClick={handleClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={handleRegister}
              variant="contained"
              disabled={submitting || name.trim() === ''}
            >
              {submitting ? 'Registering…' : 'Register device'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
};

export const DevicesListPage = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const { showUuids } = useSettings();
  const roomNames = useRoomNameLookup();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [roomFilter, setRoomFilter] = useState<RoomFilter>('all');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerDialogKey, setRegisterDialogKey] = useState(0);

  const buildQuery = (cursor?: string) => {
    const query: {
      search?: string;
      active?: boolean;
      roomUid?: string;
      cursor?: string;
      limit: number;
    } = { limit: PAGE_LIMIT };
    if (search !== '') query.search = search;
    if (statusFilter !== 'all') query.active = statusFilter === 'active';
    if (roomFilter === 'unassigned') query.roomUid = '';
    if (cursor !== undefined) query.cursor = cursor;
    return query;
  };

  const {
    items: devices,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    reload,
  } = useAsyncList<Device>(
    (cursor) => adminApi.listDevices(buildQuery(cursor)),
    [search, statusFilter, roomFilter],
  );

  const misconfigured = isApiErrorCode(error, 'BACKEND_MISCONFIGURATION');

  // Any non-misconfiguration load failure is surfaced as a toast, once per error.
  useEffect(() => {
    if (error !== null && !isApiErrorCode(error, 'BACKEND_MISCONFIGURATION')) {
      showError(errorMessage(error, 'Failed to load devices.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [error]);

  const renderRoomCell = (roomUid: string | null) => {
    if (roomUid === null) return 'Unassigned';
    const name = roomNames.get(roomUid);
    if (name === undefined) return roomUid;
    return <NameWithUid name={name} uid={roomUid} showUid={showUuids} />;
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
          Devices
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setRegisterDialogKey((k) => k + 1);
            setRegisterOpen(true);
          }}
        >
          Register device
        </Button>
      </Box>
      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}
      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
        <TextField
          label="Search devices"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          fullWidth
          size="small"
        />
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="devices-status-filter-label">Status</InputLabel>
          <Select
            labelId="devices-status-filter-label"
            label="Status"
            value={statusFilter}
            onChange={(e: SelectChangeEvent) => {
              setStatusFilter(e.target.value as StatusFilter);
            }}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="active">Activated</MenuItem>
            <MenuItem value="pending">Pending</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="devices-room-filter-label">Room</InputLabel>
          <Select
            labelId="devices-room-filter-label"
            label="Room"
            value={roomFilter}
            onChange={(e: SelectChangeEvent) => {
              setRoomFilter(e.target.value as RoomFilter);
            }}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="unassigned">Unassigned</MenuItem>
          </Select>
        </FormControl>
      </Box>
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Presence</TableCell>
              <TableCell>Room</TableCell>
              <TableCell>Created</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            ) : devices.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No devices found.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              devices.map((device) => (
                <TableRow
                  key={device.uid}
                  hover
                  onClick={() => {
                    void navigate(`/devices/${device.uid}`);
                  }}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <NameWithUid
                        name={device.name}
                        uid={device.uid}
                        showUid={showUuids}
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
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={device.active ? 'Activated' : 'Pending'}
                      color={device.active ? 'success' : 'warning'}
                    />
                  </TableCell>
                  <TableCell>
                    {/* Distinct from Status: a device can be activated and
                        still be unplugged. `online` is derived server-side so
                        every view agrees on the cutoff. */}
                    <Tooltip
                      title={
                        device.lastSeenAt === null
                          ? 'Never seen'
                          : `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                      }
                    >
                      <Chip
                        size="small"
                        label={device.online ? 'Online' : 'Offline'}
                        color={device.online ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </Tooltip>
                  </TableCell>
                  <TableCell>{renderRoomCell(device.roomUid)}</TableCell>
                  <TableCell>
                    {new Date(device.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {hasMore && !loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </Box>
      )}
      <RegisterDeviceDialog
        key={registerDialogKey}
        open={registerOpen}
        onClose={() => {
          setRegisterOpen(false);
        }}
        onRegistered={reload}
      />
    </Box>
  );
};
