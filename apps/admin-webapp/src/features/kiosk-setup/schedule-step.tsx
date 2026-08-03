import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import Link from '@mui/material/Link';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

import { Link as RouterLink } from 'react-router-dom';

import type {
  AutoSessionWindow,
  SessionSchedule,
} from '@scribear/session-manager-schema';

import type {
  CreateAutoWindowBody,
  CreateScheduleBody,
  DayOfWeek,
  ScheduleFrequency,
  SessionScope,
} from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';

import type { CommonFormState } from './schedule-form-utils';
import {
  dateToInput,
  describeSchedule,
  describeWindow,
  resolveActiveRange,
} from './schedule-form-utils';

/** Academic day letters: R is Thursday, U is Sunday. */
const DAY_TOGGLES: readonly {
  value: DayOfWeek;
  letter: string;
  name: string;
}[] = [
  { value: 'MON', letter: 'M', name: 'Monday' },
  { value: 'TUE', letter: 'T', name: 'Tuesday' },
  { value: 'WED', letter: 'W', name: 'Wednesday' },
  { value: 'THU', letter: 'R', name: 'Thursday' },
  { value: 'FRI', letter: 'F', name: 'Friday' },
  { value: 'SAT', letter: 'S', name: 'Saturday' },
  { value: 'SUN', letter: 'U', name: 'Sunday' },
];
const WEEKDAYS: readonly DayOfWeek[] = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
const SCOPES: readonly SessionScope[] = [
  'SEND_AUDIO',
  'RECEIVE_TRANSCRIPTIONS',
];
const FREQUENCIES: readonly ScheduleFrequency[] = [
  'ONCE',
  'WEEKLY',
  'BIWEEKLY',
];
const RANGE_DAYS = 90;

interface ScheduleFormState extends CommonFormState {
  name: string;
  frequency: ScheduleFrequency;
}

interface WindowFormState extends CommonFormState {
  enableAutoSessions: boolean;
}

function commonDefaults(): CommonFormState {
  return {
    daysOfWeek: [],
    localStartTime: '09:00',
    localEndTime: '10:00',
    startsOn: dateToInput(new Date()),
    indefinite: true,
    endsOn: '',
    joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: '{}',
  };
}

function emptyScheduleForm(): ScheduleFormState {
  return { ...commonDefaults(), name: '', frequency: 'WEEKLY' };
}

function emptyWindowForm(): WindowFormState {
  return {
    ...commonDefaults(),
    // Open hours describe a working day, not a single class period.
    daysOfWeek: [...WEEKDAYS],
    localStartTime: '08:00',
    localEndTime: '17:00',
    enableAutoSessions: true,
  };
}

interface DayTogglesProps {
  idPrefix: string;
  value: DayOfWeek[];
  onChange: (days: DayOfWeek[]) => void;
  disabled: boolean;
  error?: boolean;
}

const DayToggles = ({
  idPrefix,
  value,
  onChange,
  disabled,
  error = false,
}: DayTogglesProps) => {
  const labelId = `${idPrefix}-days-label`;
  const errorId = `${idPrefix}-days-error`;
  return (
    <Box>
      <Typography
        id={labelId}
        variant="body2"
        color={error ? 'error' : 'text.secondary'}
        gutterBottom
      >
        Days
      </Typography>
      <ToggleButtonGroup
        value={value}
        onChange={(_e, next: DayOfWeek[]) => {
          onChange(next);
        }}
        disabled={disabled}
        size="small"
        aria-labelledby={labelId}
        aria-invalid={error || undefined}
        aria-describedby={error ? errorId : undefined}
      >
        {DAY_TOGGLES.map((d) => (
          <ToggleButton key={d.value} value={d.value} aria-label={d.name}>
            {d.letter}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {error && (
        <Typography
          id={errorId}
          variant="caption"
          color="error"
          sx={{
            display: 'block',
          }}
        >
          Pick at least one day of the week.
        </Typography>
      )}
    </Box>
  );
};

interface TimeRangeFieldsProps {
  form: CommonFormState;
  onChange: (patch: Partial<CommonFormState>) => void;
  roomTimezone: string;
  startLabel: string;
  endLabel: string;
}

const TimeRangeFields = ({
  form,
  onChange,
  roomTimezone,
  startLabel,
  endLabel,
}: TimeRangeFieldsProps) => (
  <Box>
    <Stack direction="row" spacing={2}>
      <TextField
        label={startLabel}
        type="time"
        value={form.localStartTime}
        onChange={(e) => {
          onChange({ localStartTime: e.target.value });
        }}
        fullWidth
        slotProps={{ inputLabel: { shrink: true } }}
      />
      <TextField
        label={endLabel}
        type="time"
        value={form.localEndTime}
        onChange={(e) => {
          onChange({ localEndTime: e.target.value });
        }}
        fullWidth
        slotProps={{ inputLabel: { shrink: true } }}
      />
    </Stack>
    <Typography
      variant="caption"
      sx={{
        color: 'text.secondary',
      }}
    >
      Wall-clock time in {roomTimezone}. An end time before the start time wraps
      past midnight.
    </Typography>
  </Box>
);

interface DateRangeFieldsProps {
  form: CommonFormState;
  onChange: (patch: Partial<CommonFormState>) => void;
}

const DateRangeFields = ({ form, onChange }: DateRangeFieldsProps) => (
  <Box>
    {/* `Ends on` stays mounted but disabled so ticking "No end date" doesn't
        reflow the row. */}
    <Stack direction="row" spacing={2}>
      <TextField
        label="Starts on"
        type="date"
        value={form.startsOn}
        onChange={(e) => {
          onChange({ startsOn: e.target.value });
        }}
        fullWidth
        slotProps={{ inputLabel: { shrink: true } }}
      />
      <TextField
        label="Ends on"
        type="date"
        value={form.endsOn}
        onChange={(e) => {
          onChange({ endsOn: e.target.value });
        }}
        disabled={form.indefinite}
        fullWidth
        slotProps={{ inputLabel: { shrink: true } }}
      />
    </Stack>
    <FormControlLabel
      control={
        <Checkbox
          checked={form.indefinite}
          onChange={(e) => {
            onChange({ indefinite: e.target.checked });
          }}
        />
      }
      label="No end date"
    />
  </Box>
);

interface AdvancedFieldsProps {
  idPrefix: string;
  form: CommonFormState;
  onChange: (patch: Partial<CommonFormState>) => void;
  jsonError: string | null;
  /** Frequency selector, rendered first. Schedules only — windows are weekly. */
  frequencyField?: ReactNode;
}

const AdvancedFields = ({
  idPrefix,
  form,
  onChange,
  jsonError,
  frequencyField,
}: AdvancedFieldsProps) => (
  <Accordion variant="outlined" disableGutters>
    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
      <Typography variant="body2">Advanced</Typography>
    </AccordionSummary>
    <AccordionDetails>
      <Stack spacing={2}>
        {frequencyField}
        <FormControl fullWidth>
          <InputLabel id={`${idPrefix}-scopes-label`}>
            Join code scopes
          </InputLabel>
          <Select<SessionScope[]>
            labelId={`${idPrefix}-scopes-label`}
            label="Join code scopes"
            multiple
            value={form.joinCodeScopes}
            onChange={(e: SelectChangeEvent<SessionScope[]>) => {
              const v = e.target.value;
              onChange({
                joinCodeScopes:
                  typeof v === 'string' ? (v.split(',') as SessionScope[]) : v,
              });
            }}
            renderValue={(selected) => selected.join(', ')}
          >
            {SCOPES.map((opt) => (
              <MenuItem key={opt} value={opt}>
                <Checkbox checked={form.joinCodeScopes.includes(opt)} />
                <ListItemText primary={opt} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          label="Transcription provider ID"
          value={form.transcriptionProviderId}
          onChange={(e) => {
            onChange({ transcriptionProviderId: e.target.value });
          }}
          fullWidth
        />
        <TextField
          label="Transcription stream config (JSON)"
          value={form.transcriptionStreamConfig}
          onChange={(e) => {
            onChange({ transcriptionStreamConfig: e.target.value });
          }}
          fullWidth
          multiline
          minRows={3}
          error={jsonError !== null}
          helperText={jsonError ?? 'Must be valid JSON, e.g. {}'}
        />
      </Stack>
    </AccordionDetails>
  </Accordion>
);

interface ModeLabelProps {
  title: string;
  detail: string;
}

const ModeLabel = ({ title, detail }: ModeLabelProps) => (
  <Box sx={{ py: 0.5 }}>
    <Typography variant="body1">{title}</Typography>
    <Typography
      variant="body2"
      sx={{
        color: 'text.secondary',
      }}
    >
      {detail}
    </Typography>
  </Box>
);

type Mode = 'none' | 'schedule' | 'auto';

export interface ScheduleStepProps {
  roomUid: string | null;
  roomTimezone: string;
  onCreated: () => void;
}

/**
 * Compact schedule editor for the kiosk wizard. Covers the two common setups —
 * a recurring class meeting, or all-day open hours with auto-sessions — inline;
 * anything more elaborate is a link away on the room's scheduling page.
 */
export const ScheduleStep = ({
  roomUid,
  roomTimezone,
  onCreated,
}: ScheduleStepProps) => {
  const { showSuccess, showError, showApiError } = useToast();
  const [mode, setMode] = useState<Mode>('none');
  const [scheduleForm, setScheduleForm] =
    useState<ScheduleFormState>(emptyScheduleForm);
  const [windowForm, setWindowForm] =
    useState<WindowFormState>(emptyWindowForm);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [daysError, setDaysError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  const [schedules, setSchedules] = useState<SessionSchedule[]>([]);
  const [windows, setWindows] = useState<AutoSessionWindow[]>([]);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (roomUid === null) return;
    const alive = { current: true };
    const range = {
      roomUid,
      from: new Date().toISOString(),
      to: new Date(Date.now() + RANGE_DAYS * 86_400_000).toISOString(),
    };
    // Not converted to useAsyncData: this effect seeds locally-mutable state —
    // `schedules`/`windows`/`autoEnabled`, which the create handlers below
    // optimistically append to without refetching, plus the `windowForm`
    // default and a `misconfigured` banner those handlers also set — so it does
    // not fit the read-only useAsyncData idiom. Suppression kept deliberately.
    // eslint-disable-next-line react-hooks/set-state-in-effect, @eslint-react/set-state-in-effect -- see REVIEW-EFFECT-SETState.md
    setLoading(true);
    Promise.all([
      adminApi.listSchedules(range),
      adminApi.listAutoWindows(range),
      adminApi.roomDetail(roomUid),
    ])
      .then(([s, w, detail]) => {
        if (!alive.current) return;
        setSchedules(s.items);
        setWindows(w.items);
        setAutoEnabled(detail.room.autoSessionEnabled);
        setWindowForm((f) => ({
          ...f,
          enableAutoSessions: !detail.room.autoSessionEnabled,
        }));
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showApiError(err, "Failed to load the room's schedules.");
        }
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [roomUid]);

  const patchSchedule = (patch: Partial<CommonFormState>) => {
    setScheduleForm((f) => ({ ...f, ...patch }));
  };
  const patchWindow = (patch: Partial<CommonFormState>) => {
    setWindowForm((f) => ({ ...f, ...patch }));
  };

  /** Parses the shared advanced JSON field, reporting inline on failure. */
  const parseStreamConfig = (raw: string): { value: unknown } | null => {
    try {
      return { value: JSON.parse(raw) };
    } catch {
      setJsonError('Invalid JSON.');
      return null;
    }
  };

  const handleCreateSchedule = () => {
    if (roomUid === null) return;
    setJsonError(null);

    if (
      scheduleForm.frequency !== 'ONCE' &&
      scheduleForm.daysOfWeek.length === 0
    ) {
      setDaysError(true);
      showError('Pick at least one day of the week.');
      return;
    }
    const range = resolveActiveRange(scheduleForm, true);
    if (!range.ok) {
      showError(range.error);
      return;
    }
    const parsed = parseStreamConfig(scheduleForm.transcriptionStreamConfig);
    if (parsed === null) return;

    const body: CreateScheduleBody = {
      roomUid,
      name: scheduleForm.name.trim(),
      activeStart: range.activeStart,
      activeEnd: range.activeEnd,
      localStartTime: scheduleForm.localStartTime,
      localEndTime: scheduleForm.localEndTime,
      frequency: scheduleForm.frequency,
      daysOfWeek:
        scheduleForm.frequency === 'ONCE' ? null : scheduleForm.daysOfWeek,
      joinCodeScopes: scheduleForm.joinCodeScopes,
      transcriptionProviderId: scheduleForm.transcriptionProviderId,
      transcriptionStreamConfig: parsed.value,
    };

    setSubmitting(true);
    setMisconfigured(false);
    adminApi
      .createSchedule(body)
      .then((created) => {
        showSuccess('Schedule created.');
        setSchedules((prev) => [...prev, created]);
        setScheduleForm(emptyScheduleForm());
        setMode('none');
        onCreated();
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showApiError(err, 'Failed to create schedule.');
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const handleCreateWindow = () => {
    if (roomUid === null) return;
    setJsonError(null);

    if (windowForm.daysOfWeek.length === 0) {
      setDaysError(true);
      showError('Pick at least one day of the week.');
      return;
    }
    // Windows accept a past `activeStart`, so anchor at midnight — that keeps
    // today's open hours intact when a kiosk is set up mid-morning.
    const range = resolveActiveRange(windowForm, false);
    if (!range.ok) {
      showError(range.error);
      return;
    }
    const parsed = parseStreamConfig(windowForm.transcriptionStreamConfig);
    if (parsed === null) return;

    const body: CreateAutoWindowBody = {
      roomUid,
      localStartTime: windowForm.localStartTime,
      localEndTime: windowForm.localEndTime,
      daysOfWeek: windowForm.daysOfWeek,
      activeStart: range.activeStart,
      activeEnd: range.activeEnd,
      joinCodeScopes: windowForm.joinCodeScopes,
      transcriptionProviderId: windowForm.transcriptionProviderId,
      transcriptionStreamConfig: parsed.value,
    };
    const alsoEnable = windowForm.enableAutoSessions && !autoEnabled;

    setSubmitting(true);
    setMisconfigured(false);
    adminApi
      .createAutoWindow(body)
      .then((created) => {
        setWindows((prev) => [...prev, created]);
        if (!alsoEnable) return null;
        // The master switch is what actually makes the window produce
        // sessions, so a failure here is reported on its own.
        return adminApi
          .updateRoomScheduleConfig({ roomUid, autoSessionEnabled: true })
          .then((room) => {
            setAutoEnabled(room.autoSessionEnabled);
            return null;
          })
          .catch((err: unknown) => {
            showApiError(
              err,
              'Open hours saved, but auto-sessions could not be enabled for the room.',
            );
            return null;
          });
      })
      .then(() => {
        showSuccess('Open hours saved.');
        setWindowForm({ ...emptyWindowForm(), enableAutoSessions: false });
        setMode('none');
        onCreated();
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showApiError(err, 'Failed to save open hours.');
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  if (roomUid === null) {
    return (
      <Typography
        sx={{
          color: 'text.secondary',
        }}
      >
        Attach this device to a room first — schedules belong to the room.
      </Typography>
    );
  }

  const hasExisting = schedules.length > 0 || windows.length > 0;

  return (
    <Stack spacing={2}>
      {misconfigured && (
        <Alert severity="error">
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
        }}
      >
        A room can capture in two ways. Pick whichever matches how this space is
        used — both can be combined later from the room&apos;s scheduling page,
        and a room with neither only records when someone starts a session by
        hand.
      </Typography>
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <CircularProgress
            size={24}
            aria-label="Loading this room's schedule"
          />
        </Box>
      ) : (
        hasExisting && (
          <Alert severity="info">
            <Typography variant="body2">
              This room is already set up:
            </Typography>
            {schedules.map((s) => (
              <Typography key={s.uid} variant="body2">
                • {describeSchedule(s)}
              </Typography>
            ))}
            {windows.map((w) => (
              <Typography key={w.uid} variant="body2">
                • Open hours {describeWindow(w)}
                {autoEnabled ? '' : ' (auto-sessions are off for this room)'}
              </Typography>
            ))}
          </Alert>
        )
      )}
      <RadioGroup
        value={mode}
        onChange={(e) => {
          setMode(e.target.value as Mode);
          setJsonError(null);
          setDaysError(false);
        }}
      >
        <FormControlLabel
          value="none"
          control={<Radio />}
          sx={{ alignItems: 'flex-start' }}
          label={
            <ModeLabel
              title="No schedule for now"
              detail="Set this up later from the room page."
            />
          }
        />
        <FormControlLabel
          value="schedule"
          control={<Radio />}
          sx={{ alignItems: 'flex-start' }}
          label={
            <ModeLabel
              title="Recurring schedule"
              detail="A named session that runs at a fixed time on the days you pick — a class that meets MWF 09:00–09:50, say. Captions run only during those slots."
            />
          }
        />
        <FormControlLabel
          value="auto"
          control={<Radio />}
          sx={{ alignItems: 'flex-start' }}
          label={
            <ModeLabel
              title="Room open hours (auto-sessions)"
              detail="The room captures continuously through the hours you set — weekdays 08:00–17:00, say. Auto-sessions fill whatever time a named schedule hasn't already claimed, so a drop-in space needs no per-event setup."
            />
          }
        />
      </RadioGroup>
      {mode === 'schedule' && (
        <Stack spacing={2}>
          <TextField
            label="Name"
            value={scheduleForm.name}
            onChange={(e) => {
              setScheduleForm((f) => ({ ...f, name: e.target.value }));
            }}
            placeholder="CS 225 Lecture"
            fullWidth
          />
          <Box>
            <DayToggles
              idPrefix="kiosk-schedule"
              value={scheduleForm.daysOfWeek}
              onChange={(days) => {
                patchSchedule({ daysOfWeek: days });
                setDaysError(false);
              }}
              disabled={scheduleForm.frequency === 'ONCE'}
              error={daysError}
            />
            {scheduleForm.frequency === 'ONCE' && (
              <Typography
                variant="caption"
                sx={{
                  color: 'text.secondary',
                }}
              >
                A one-off schedule runs on its start date only.
              </Typography>
            )}
          </Box>
          <TimeRangeFields
            form={scheduleForm}
            onChange={patchSchedule}
            roomTimezone={roomTimezone}
            startLabel="Start time"
            endLabel="End time"
          />
          <DateRangeFields form={scheduleForm} onChange={patchSchedule} />
          <AdvancedFields
            idPrefix="kiosk-schedule"
            form={scheduleForm}
            onChange={patchSchedule}
            jsonError={jsonError}
            frequencyField={
              <FormControl fullWidth>
                <InputLabel id="kiosk-schedule-frequency-label">
                  Frequency
                </InputLabel>
                <Select
                  labelId="kiosk-schedule-frequency-label"
                  label="Frequency"
                  value={scheduleForm.frequency}
                  onChange={(e: SelectChangeEvent) => {
                    setScheduleForm((f) => ({
                      ...f,
                      frequency: e.target.value as ScheduleFrequency,
                    }));
                  }}
                >
                  {FREQUENCIES.map((f) => (
                    <MenuItem key={f} value={f}>
                      {f}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            }
          />
          <Box>
            <Button
              variant="contained"
              onClick={handleCreateSchedule}
              disabled={submitting || scheduleForm.name.trim() === ''}
            >
              {submitting ? 'Creating…' : 'Create schedule'}
            </Button>
          </Box>
        </Stack>
      )}
      {mode === 'auto' && (
        <Stack spacing={2}>
          <DayToggles
            idPrefix="kiosk-window"
            value={windowForm.daysOfWeek}
            onChange={(days) => {
              patchWindow({ daysOfWeek: days });
              setDaysError(false);
            }}
            disabled={false}
            error={daysError}
          />
          <TimeRangeFields
            form={windowForm}
            onChange={patchWindow}
            roomTimezone={roomTimezone}
            startLabel="Opens at"
            endLabel="Closes at"
          />
          <DateRangeFields form={windowForm} onChange={patchWindow} />
          {autoEnabled ? (
            <Alert severity="success">
              Auto-sessions are already enabled for this room, so these hours
              take effect as soon as you save.
            </Alert>
          ) : (
            <Box>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={windowForm.enableAutoSessions}
                    onChange={(e) => {
                      setWindowForm((f) => ({
                        ...f,
                        enableAutoSessions: e.target.checked,
                      }));
                    }}
                  />
                }
                label="Enable auto-sessions for this room"
              />
              <Typography
                variant="caption"
                sx={{
                  display: 'block',
                  color: 'text.secondary',
                }}
              >
                {windowForm.enableAutoSessions
                  ? "This room's master switch is off. Saving will turn it on."
                  : 'Leaving this off saves the hours but produces no sessions until the master switch is turned on from the room page.'}
              </Typography>
            </Box>
          )}
          <AdvancedFields
            idPrefix="kiosk-window"
            form={windowForm}
            onChange={patchWindow}
            jsonError={jsonError}
          />
          <Box>
            <Button
              variant="contained"
              onClick={handleCreateWindow}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : 'Save open hours'}
            </Button>
          </Box>
        </Stack>
      )}
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
        }}
      >
        Need one-off sessions, several schedules, or edits?{' '}
        <Link component={RouterLink} to={`/rooms/${roomUid}/scheduling`}>
          Open the room&apos;s scheduling page
        </Link>
        .
      </Typography>
    </Stack>
  );
};
