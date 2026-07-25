import { useEffect, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { Link as RouterLink } from 'react-router-dom';

import type { Room } from '@scribear/session-manager-schema';

import { ActivationCodeDisplay } from '#src/components/activation-code-display';
import { ScheduleStep } from '#src/features/kiosk-setup/schedule-step';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

const DEFAULT_TIMEZONE = 'America/Chicago';
const POLL_MS = 3000;
const STEPS = ['Device', 'Room', 'Schedule', 'Verify'];

type RoomChoice = 'new' | 'existing';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface DeviceStepProps {
  deviceName: string;
  setDeviceName: (name: string) => void;
  deviceUid: string | null;
  activationCode: string | null;
  activationExpiry: string | null;
  registering: boolean;
  reregistering: boolean;
  misconfigured: boolean;
  onRegister: () => void;
  onReregister: () => void;
}

const DeviceStep = ({
  deviceName,
  setDeviceName,
  deviceUid,
  activationCode,
  activationExpiry,
  registering,
  reregistering,
  misconfigured,
  onRegister,
  onReregister,
}: DeviceStepProps) => (
  <Stack spacing={2}>
    <Typography
      variant="body2"
      sx={{
        color: 'text.secondary',
      }}
    >
      Register a new device to get an activation code. Enter the code on the
      kiosk to link it to this device record.
    </Typography>
    {misconfigured && (
      <Alert severity="error">
        Admin backend misconfiguration — an operator must check the
        server&apos;s ADMIN_API_KEY.
      </Alert>
    )}
    <TextField
      label="Device name"
      value={deviceName}
      onChange={(e) => {
        setDeviceName(e.target.value);
      }}
      disabled={deviceUid !== null}
      fullWidth
    />
    {deviceUid === null ? (
      <Box>
        <Button
          variant="contained"
          onClick={onRegister}
          disabled={registering || deviceName.trim() === ''}
        >
          {registering ? 'Registering…' : 'Register device'}
        </Button>
      </Box>
    ) : (
      activationCode !== null &&
      activationExpiry !== null && (
        <Stack
          spacing={1}
          sx={{
            alignItems: 'center',
          }}
        >
          <ActivationCodeDisplay
            code={activationCode}
            expiry={activationExpiry}
          />
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            On the kiosk browser, open /kiosk and enter this code.
          </Typography>
          <Button onClick={onReregister} disabled={reregistering} size="small">
            {reregistering ? 'Re-registering…' : 'Code expired? Re-register'}
          </Button>
        </Stack>
      )
    )}
  </Stack>
);

interface RoomStepProps {
  deviceUid: string | null;
  roomUid: string | null;
  roomChoice: RoomChoice;
  setRoomChoice: (choice: RoomChoice) => void;
  newRoomName: string;
  setNewRoomName: (name: string) => void;
  newRoomTimezone: string;
  setNewRoomTimezone: (tz: string) => void;
  existingRooms: Room[];
  existingRoomsLoading: boolean;
  selectedRoomUid: string;
  setSelectedRoomUid: (uid: string) => void;
  roomSubmitting: boolean;
  misconfigured: boolean;
  onCreateRoom: () => void;
  onAddToRoom: () => void;
}

const RoomStep = ({
  roomUid,
  roomChoice,
  setRoomChoice,
  newRoomName,
  setNewRoomName,
  newRoomTimezone,
  setNewRoomTimezone,
  existingRooms,
  existingRoomsLoading,
  selectedRoomUid,
  setSelectedRoomUid,
  roomSubmitting,
  misconfigured,
  onCreateRoom,
  onAddToRoom,
}: RoomStepProps) => {
  if (roomUid !== null) {
    return (
      <Alert severity="success">
        Device added to room <strong>{roomUid}</strong>.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      {misconfigured && (
        <Alert severity="error">
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}
      <RadioGroup
        value={roomChoice}
        onChange={(_e, value) => {
          setRoomChoice(value as RoomChoice);
        }}
      >
        <FormControlLabel
          value="new"
          control={<Radio />}
          label="Create a new room"
        />
        <FormControlLabel
          value="existing"
          control={<Radio />}
          label="Add to an existing room"
        />
      </RadioGroup>
      {roomChoice === 'new' ? (
        <Stack spacing={2}>
          <TextField
            label="Room name"
            value={newRoomName}
            onChange={(e) => {
              setNewRoomName(e.target.value);
            }}
            fullWidth
          />
          <TextField
            label="Timezone"
            value={newRoomTimezone}
            onChange={(e) => {
              setNewRoomTimezone(e.target.value);
            }}
            helperText="IANA timezone identifier, e.g. America/Chicago"
            fullWidth
          />
          <Box>
            <Button
              variant="contained"
              onClick={onCreateRoom}
              disabled={
                roomSubmitting ||
                newRoomName.trim() === '' ||
                newRoomTimezone.trim() === ''
              }
            >
              {roomSubmitting ? 'Creating…' : 'Create room'}
            </Button>
          </Box>
        </Stack>
      ) : (
        <Stack spacing={2}>
          <FormControl
            fullWidth
            disabled={existingRoomsLoading || existingRooms.length === 0}
          >
            <InputLabel id="kiosk-wizard-existing-room-label">Room</InputLabel>
            <Select
              labelId="kiosk-wizard-existing-room-label"
              label="Room"
              value={selectedRoomUid}
              onChange={(e: SelectChangeEvent) => {
                setSelectedRoomUid(e.target.value);
              }}
            >
              {existingRooms.map((r) => (
                <MenuItem key={r.uid} value={r.uid}>
                  {r.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {existingRoomsLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center' }}>
              <CircularProgress size={24} aria-label="Loading rooms" />
            </Box>
          )}
          {!existingRoomsLoading && existingRooms.length === 0 && (
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
              }}
            >
              No rooms exist yet. Create a new room instead.
            </Typography>
          )}
          <Box>
            <Button
              variant="contained"
              onClick={onAddToRoom}
              disabled={roomSubmitting || selectedRoomUid === ''}
            >
              {roomSubmitting ? 'Adding…' : 'Add to room'}
            </Button>
          </Box>
        </Stack>
      )}
    </Stack>
  );
};

interface VerifyStepProps {
  deviceUid: string | null;
  roomUid: string | null;
  deviceActive: boolean;
}

const VerifyStep = ({ deviceUid, roomUid, deviceActive }: VerifyStepProps) => {
  if (deviceActive) {
    return (
      <Stack
        spacing={2}
        sx={{
          alignItems: 'flex-start',
        }}
      >
        <Alert severity="success" sx={{ width: '100%' }}>
          Activated ✓
        </Alert>
        <Stack direction="row" spacing={3}>
          {roomUid !== null && (
            <Link component={RouterLink} to={`/rooms/${roomUid}`}>
              View room
            </Link>
          )}
          {deviceUid !== null && (
            <Link component={RouterLink} to={`/devices/${deviceUid}`}>
              View device
            </Link>
          )}
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack
      spacing={2}
      sx={{
        alignItems: 'center',
        py: 4,
      }}
    >
      <CircularProgress aria-label="Waiting for the kiosk to activate" />
      <Typography
        sx={{
          color: 'text.secondary',
        }}
      >
        Waiting for the kiosk to activate…
      </Typography>
    </Stack>
  );
};

/**
 * Guided kiosk setup: register a device, attach it to a room (new or
 * existing), optionally give the room a recurring schedule, then poll until
 * the kiosk has activated using the code.
 */
export const KioskWizardPage = () => {
  const { showSuccess, showError } = useToast();
  const [activeStep, setActiveStep] = useState(0);

  // Step 0: device
  const [deviceName, setDeviceName] = useState('');
  const [deviceUid, setDeviceUid] = useState<string | null>(null);
  const [activationCode, setActivationCode] = useState<string | null>(null);
  const [activationExpiry, setActivationExpiry] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [reregistering, setReregistering] = useState(false);
  const [deviceMisconfigured, setDeviceMisconfigured] = useState(false);

  // Step 1: room
  const [roomChoice, setRoomChoice] = useState<RoomChoice>('new');
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomTimezone, setNewRoomTimezone] = useState(DEFAULT_TIMEZONE);
  const [selectedRoomUid, setSelectedRoomUid] = useState('');
  const [roomUid, setRoomUid] = useState<string | null>(null);
  const [roomSubmitting, setRoomSubmitting] = useState(false);
  // Set only by the create/add-room mutations; the room-list load's own
  // misconfiguration is folded in via `roomStepMisconfigured` below.
  const [roomMisconfigured, setRoomMisconfigured] = useState(false);

  // Existing rooms are loaded only once the operator picks "existing"; the
  // fetcher no-ops (resolves []) otherwise.
  const {
    data: existingRoomsData,
    loading: existingRoomsLoading,
    error: existingRoomsError,
  } = useAsyncData<Room[]>(
    () =>
      roomChoice === 'existing'
        ? adminApi.listRooms({ limit: 200 }).then((res) => res.items)
        : Promise.resolve([]),
    [roomChoice],
  );
  const existingRooms = existingRoomsData ?? [];
  const roomStepMisconfigured =
    roomMisconfigured ||
    isApiErrorCode(existingRoomsError, 'BACKEND_MISCONFIGURATION');

  // Step 2: schedule
  const [schedulesCreated, setSchedulesCreated] = useState(0);

  // Step 3: verify
  const [deviceActive, setDeviceActive] = useState(false);

  const handleRegister = () => {
    setRegistering(true);
    setDeviceMisconfigured(false);
    adminApi
      .registerDevice(deviceName)
      .then((r) => {
        setDeviceUid(r.deviceUid);
        setActivationCode(r.activationCode);
        setActivationExpiry(r.expiry);
        showSuccess('Device registered.');
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setDeviceMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to register device.'));
        }
      })
      .finally(() => {
        setRegistering(false);
      });
  };

  const handleReregister = () => {
    if (deviceUid === null) return;
    setReregistering(true);
    adminApi
      .reregisterDevice(deviceUid)
      .then((r) => {
        setActivationCode(r.activationCode);
        setActivationExpiry(r.expiry);
        showSuccess('New activation code generated.');
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to re-register device.'));
      })
      .finally(() => {
        setReregistering(false);
      });
  };

  // Non-misconfiguration room-list failures are surfaced as a toast, once per
  // error (misconfiguration is shown inline via `roomStepMisconfigured`).
  useEffect(() => {
    if (
      existingRoomsError !== null &&
      !isApiErrorCode(existingRoomsError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(errorMessage(existingRoomsError, 'Failed to load rooms.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [existingRoomsError]);

  const handleCreateRoom = () => {
    if (deviceUid === null) return;
    setRoomSubmitting(true);
    setRoomMisconfigured(false);
    adminApi
      .createRoom({
        name: newRoomName,
        timezone: newRoomTimezone,
        autoSessionEnabled: false,
        sourceDeviceUids: [deviceUid],
      })
      .then((room) => {
        setRoomUid(room.uid);
        showSuccess('Room created.');
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setRoomMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to create room.'));
        }
      })
      .finally(() => {
        setRoomSubmitting(false);
      });
  };

  const handleAddToRoom = () => {
    if (deviceUid === null || selectedRoomUid === '') return;
    setRoomSubmitting(true);
    setRoomMisconfigured(false);
    adminApi
      .addDeviceToRoom({ roomUid: selectedRoomUid, deviceUid, asSource: true })
      .then(() => {
        setRoomUid(selectedRoomUid);
        showSuccess('Device added to room.');
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setRoomMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to add device to room.'));
        }
      })
      .finally(() => {
        setRoomSubmitting(false);
      });
  };

  useEffect(() => {
    if (activeStep !== 3 || deviceUid === null || deviceActive) return;
    const alive = { current: true };
    const poll = () => {
      adminApi
        .getDevice(deviceUid)
        .then((d) => {
          if (alive.current && d.active) setDeviceActive(true);
        })
        .catch(() => {
          /* transient poll failure — try again on the next tick */
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [activeStep, deviceUid, deviceActive]);

  const canGoNext =
    (activeStep === 0 && deviceUid !== null) ||
    (activeStep === 1 && roomUid !== null) ||
    activeStep === 2;

  // The room step either creates a room with `newRoomTimezone` or attaches to
  // one already listed in `existingRooms`, so one of the two always resolves.
  const roomTimezone =
    existingRooms.find((r) => r.uid === roomUid)?.timezone ?? newRoomTimezone;

  const handleNext = () => {
    setActiveStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const handleBack = () => {
    setActiveStep((s) => Math.max(s - 1, 0));
  };

  return (
    <Box>
      <Typography variant="h5" component="h1" gutterBottom>
        Set up a kiosk
      </Typography>
      <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
        {STEPS.map((label, index) => (
          <Step key={label}>
            <StepLabel aria-current={index === activeStep ? 'step' : undefined}>
              {label}
            </StepLabel>
          </Step>
        ))}
      </Stepper>
      {/* Plain StepLabel (no StepButton) never gets aria-current from MUI, and
          the step change is otherwise silent to a screen reader — announce it
          explicitly. */}
      <Typography
        aria-live="polite"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {`Step ${String(activeStep + 1)} of ${String(STEPS.length)}: ${STEPS[activeStep] ?? ''}`}
      </Typography>
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        {activeStep === 0 && (
          <DeviceStep
            deviceName={deviceName}
            setDeviceName={setDeviceName}
            deviceUid={deviceUid}
            activationCode={activationCode}
            activationExpiry={activationExpiry}
            registering={registering}
            reregistering={reregistering}
            misconfigured={deviceMisconfigured}
            onRegister={handleRegister}
            onReregister={handleReregister}
          />
        )}
        {activeStep === 1 && (
          <RoomStep
            deviceUid={deviceUid}
            roomUid={roomUid}
            roomChoice={roomChoice}
            setRoomChoice={setRoomChoice}
            newRoomName={newRoomName}
            setNewRoomName={setNewRoomName}
            newRoomTimezone={newRoomTimezone}
            setNewRoomTimezone={setNewRoomTimezone}
            existingRooms={existingRooms}
            existingRoomsLoading={existingRoomsLoading}
            selectedRoomUid={selectedRoomUid}
            setSelectedRoomUid={setSelectedRoomUid}
            roomSubmitting={roomSubmitting}
            misconfigured={roomStepMisconfigured}
            onCreateRoom={handleCreateRoom}
            onAddToRoom={handleAddToRoom}
          />
        )}
        {activeStep === 2 && (
          <ScheduleStep
            roomUid={roomUid}
            roomTimezone={roomTimezone}
            onCreated={() => {
              setSchedulesCreated((n) => n + 1);
            }}
          />
        )}
        {activeStep === 3 && (
          <VerifyStep
            deviceUid={deviceUid}
            roomUid={roomUid}
            deviceActive={deviceActive}
          />
        )}
      </Paper>
      <Stack
        direction="row"
        spacing={2}
        sx={{
          justifyContent: 'space-between',
        }}
      >
        <Button onClick={handleBack} disabled={activeStep === 0}>
          Back
        </Button>
        {activeStep < STEPS.length - 1 && (
          <Button
            variant="contained"
            onClick={handleNext}
            disabled={!canGoNext}
          >
            {activeStep === 2 && schedulesCreated === 0 ? 'Skip' : 'Next'}
          </Button>
        )}
      </Stack>
    </Box>
  );
};
