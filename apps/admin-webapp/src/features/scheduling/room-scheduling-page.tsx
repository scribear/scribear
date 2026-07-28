import { type SyntheticEvent, useEffect, useMemo, useState } from 'react';

import AddIcon from '@mui/icons-material/Add';
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
import FormHelperText from '@mui/material/FormHelperText';
import Grid from '@mui/material/Grid';
import InputLabel from '@mui/material/InputLabel';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useNavigate, useParams } from 'react-router-dom';

import type {
  AutoSessionWindow,
  Room,
  Session,
  SessionSchedule,
} from '@scribear/session-manager-schema';

import { ConfirmDialog } from '#src/components/confirm-dialog';
import type {
  CreateAutoWindowBody,
  CreateOnDemandSessionBody,
  CreateScheduleBody,
  DayOfWeek,
  ScheduleFrequency,
  SessionScope,
  UpdateAutoWindowBody,
  UpdateScheduleBody,
} from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

import {
  diffAutoWindowUpdate,
  diffScheduleUpdate,
} from './room-scheduling-form-utils';

const DAYS_OF_WEEK: readonly DayOfWeek[] = [
  'SUN',
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
];
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
// How far back the scheduling page looks. The session listing uses an overlap
// predicate, so a session that started before page-load (e.g. an active
// on-demand session) still appears. The schedule/window listing filters on
// `active_start <= to`, so this primarily governs sessions.
const LOOKBACK_DAYS = 7;
// The scheduling page has no server-push; poll the session list so a session
// created or started elsewhere (e.g. by the auto-session reconciler, or by
// another operator) appears without a manual reload. Gated on tab visibility
// in the effect below.
const SESSION_POLL_MS = 15_000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function formatInRoomTz(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Converts a `datetime-local` input value to an ISO instant, or null if empty. */
function localInputToIso(value: string): string | null {
  if (value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Converts an ISO instant to a `datetime-local` input value (browser-local). */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = String(d.getFullYear());
  return `${year}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface MultiSelectFieldProps<T extends string> {
  label: string;
  options: readonly T[];
  value: T[];
  onChange: (value: T[]) => void;
  disabled: boolean;
  error?: boolean;
  helperText?: string;
}

function MultiSelectField<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  error = false,
  helperText,
}: MultiSelectFieldProps<T>) {
  const labelId = `multiselect-${label.replace(/\s+/g, '-').toLowerCase()}`;
  const helperId = `${labelId}-helper`;
  return (
    <FormControl fullWidth margin="normal" disabled={disabled} error={error}>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select<T[]>
        labelId={labelId}
        label={label}
        multiple
        value={value}
        onChange={(e: SelectChangeEvent<T[]>) => {
          const v = e.target.value;
          onChange(typeof v === 'string' ? (v.split(',') as T[]) : v);
        }}
        renderValue={(selected) => selected.join(', ')}
        {...(helperText ? { 'aria-describedby': helperId } : {})}
      >
        {options.map((opt) => (
          <MenuItem key={opt} value={opt}>
            <Checkbox checked={value.includes(opt)} />
            <ListItemText primary={opt} />
          </MenuItem>
        ))}
      </Select>
      {helperText && (
        <FormHelperText id={helperId}>{helperText}</FormHelperText>
      )}
    </FormControl>
  );
}

/** JSON textarea for `transcriptionStreamConfig`. Parsing happens on submit. */
interface JsonConfigFieldProps {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}

const JsonConfigField = ({ value, onChange, error }: JsonConfigFieldProps) => (
  <TextField
    label="Transcription stream config (JSON)"
    value={value}
    onChange={(e) => {
      onChange(e.target.value);
    }}
    fullWidth
    margin="normal"
    multiline
    minRows={3}
    error={error !== null}
    helperText={error ?? 'Must be valid JSON, e.g. {}'}
  />
);

interface ScheduleFormState {
  name: string;
  frequency: ScheduleFrequency;
  daysOfWeek: DayOfWeek[];
  localStartTime: string;
  localEndTime: string;
  activeStart: string;
  activeEndInput: string;
  indefinite: boolean;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: string;
}

function scheduleToFormState(schedule: SessionSchedule): ScheduleFormState {
  return {
    name: schedule.name,
    frequency: schedule.frequency,
    daysOfWeek: schedule.daysOfWeek ?? [],
    localStartTime: schedule.localStartTime.slice(0, 5),
    localEndTime: schedule.localEndTime.slice(0, 5),
    activeStart: isoToLocalInput(schedule.activeStart),
    activeEndInput:
      schedule.activeEnd === null ? '' : isoToLocalInput(schedule.activeEnd),
    indefinite: schedule.activeEnd === null,
    joinCodeScopes: schedule.joinCodeScopes,
    transcriptionProviderId: schedule.transcriptionProviderId ?? 'whisper',
    transcriptionStreamConfig: JSON.stringify(
      schedule.transcriptionStreamConfig ?? {},
    ),
  };
}

interface ScheduleDialogProps {
  roomUid: string;
  schedule: SessionSchedule | null;
  onClose: () => void;
  onSaved: () => void;
}

const ScheduleDialog = ({
  roomUid,
  schedule,
  onClose,
  onSaved,
}: ScheduleDialogProps) => {
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<ScheduleFormState>(() =>
    schedule
      ? scheduleToFormState(schedule)
      : {
          name: '',
          frequency: 'ONCE',
          daysOfWeek: [],
          localStartTime: '09:00',
          localEndTime: '10:00',
          activeStart: '',
          activeEndInput: '',
          indefinite: true,
          joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: '{}',
        },
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [daysError, setDaysError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  const handleSubmit = () => {
    setJsonError(null);
    if (form.frequency !== 'ONCE' && form.daysOfWeek.length === 0) {
      setDaysError(true);
      showError('Select at least one day of week for a recurring schedule.');
      return;
    }
    const activeStartIso = localInputToIso(form.activeStart);
    if (activeStartIso === null) {
      showError('Enter a valid start date/time.');
      return;
    }
    const activeStartChanged = activeStartIso !== schedule?.activeStart;
    if (
      activeStartChanged &&
      new Date(activeStartIso).getTime() <= Date.now()
    ) {
      showError('Active start must be in the future.');
      return;
    }
    let activeEndIso: string | null = null;
    if (!form.indefinite) {
      activeEndIso = localInputToIso(form.activeEndInput);
      if (activeEndIso === null) {
        showError('Enter a valid end date/time, or mark this indefinite.');
        return;
      }
    }
    let transcriptionStreamConfig: unknown;
    try {
      transcriptionStreamConfig = JSON.parse(form.transcriptionStreamConfig);
    } catch {
      setJsonError('Invalid JSON.');
      return;
    }
    const daysOfWeek = form.frequency === 'ONCE' ? null : form.daysOfWeek;

    setSubmitting(true);
    setMisconfigured(false);

    if (schedule === null) {
      const body: CreateScheduleBody = {
        roomUid,
        name: form.name,
        activeStart: activeStartIso,
        activeEnd: activeEndIso,
        localStartTime: form.localStartTime,
        localEndTime: form.localEndTime,
        frequency: form.frequency,
        daysOfWeek,
        joinCodeScopes: form.joinCodeScopes,
        transcriptionProviderId: form.transcriptionProviderId,
        transcriptionStreamConfig,
      };
      adminApi
        .createSchedule(body)
        .then(() => {
          showSuccess('Schedule created.');
          onSaved();
        })
        .catch((err: unknown) => {
          if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
            setMisconfigured(true);
          } else {
            showError(errorMessage(err, 'Failed to create schedule.'));
          }
        })
        .finally(() => {
          setSubmitting(false);
        });
    } else {
      const body: UpdateScheduleBody = {
        scheduleUid: schedule.uid,
        ...diffScheduleUpdate(schedule, {
          name: form.name,
          activeStart: activeStartIso,
          activeEnd: activeEndIso,
          localStartTime: form.localStartTime,
          localEndTime: form.localEndTime,
          frequency: form.frequency,
          daysOfWeek,
          joinCodeScopes: form.joinCodeScopes,
          transcriptionProviderId: form.transcriptionProviderId,
          transcriptionStreamConfig,
        }),
      };
      adminApi
        .updateSchedule(body)
        .then(() => {
          showSuccess('Schedule updated.');
          onSaved();
        })
        .catch((err: unknown) => {
          if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
            setMisconfigured(true);
          } else {
            showError(errorMessage(err, 'Failed to update schedule.'));
          }
        })
        .finally(() => {
          setSubmitting(false);
        });
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {schedule === null ? 'New schedule' : 'Edit schedule'}
      </DialogTitle>
      <DialogContent>
        {misconfigured && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Admin backend misconfiguration — an operator must check the
            server&apos;s ADMIN_API_KEY.
          </Alert>
        )}
        <TextField
          label="Name"
          value={form.name}
          onChange={(e) => {
            setForm((f) => ({ ...f, name: e.target.value }));
          }}
          fullWidth
          margin="normal"
          autoFocus
        />
        <FormControl fullWidth margin="normal">
          <InputLabel id="schedule-frequency-label">Frequency</InputLabel>
          <Select
            labelId="schedule-frequency-label"
            label="Frequency"
            value={form.frequency}
            onChange={(e: SelectChangeEvent) => {
              setForm((f) => ({
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
        <MultiSelectField
          label="Days of week"
          options={DAYS_OF_WEEK}
          value={form.daysOfWeek}
          onChange={(v) => {
            setForm((f) => ({ ...f, daysOfWeek: v }));
            setDaysError(false);
          }}
          disabled={form.frequency === 'ONCE'}
          error={daysError}
          helperText={
            daysError
              ? 'Select at least one day of week for a recurring schedule.'
              : ''
          }
        />
        <Stack direction="row" spacing={2}>
          <TextField
            label="Local start time"
            type="time"
            value={form.localStartTime}
            onChange={(e) => {
              setForm((f) => ({ ...f, localStartTime: e.target.value }));
            }}
            margin="normal"
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="Local end time"
            type="time"
            value={form.localEndTime}
            onChange={(e) => {
              setForm((f) => ({ ...f, localEndTime: e.target.value }));
            }}
            margin="normal"
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Stack>
        <TextField
          label="Active start"
          type="datetime-local"
          value={form.activeStart}
          onChange={(e) => {
            setForm((f) => ({ ...f, activeStart: e.target.value }));
          }}
          margin="normal"
          fullWidth
          helperText="Must be in the future. Interpreted in your browser's local time zone."
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={form.indefinite}
              onChange={(e) => {
                setForm((f) => ({ ...f, indefinite: e.target.checked }));
              }}
            />
          }
          label="No end date (indefinite)"
        />
        {!form.indefinite && (
          <TextField
            label="Active end"
            type="datetime-local"
            value={form.activeEndInput}
            onChange={(e) => {
              setForm((f) => ({ ...f, activeEndInput: e.target.value }));
            }}
            margin="normal"
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
          />
        )}
        <MultiSelectField
          label="Join code scopes"
          options={SCOPES}
          value={form.joinCodeScopes}
          onChange={(v) => {
            setForm((f) => ({ ...f, joinCodeScopes: v }));
          }}
          disabled={false}
        />
        <TextField
          label="Transcription provider ID"
          value={form.transcriptionProviderId}
          onChange={(e) => {
            setForm((f) => ({ ...f, transcriptionProviderId: e.target.value }));
          }}
          fullWidth
          margin="normal"
        />
        <JsonConfigField
          value={form.transcriptionStreamConfig}
          onChange={(v) => {
            setForm((f) => ({ ...f, transcriptionStreamConfig: v }));
          }}
          error={jsonError}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={submitting || form.name.trim() === ''}
        >
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

interface AutoWindowFormState {
  localStartTime: string;
  localEndTime: string;
  daysOfWeek: DayOfWeek[];
  activeStart: string;
  activeEndInput: string;
  indefinite: boolean;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: string;
}

function windowToFormState(w: AutoSessionWindow): AutoWindowFormState {
  return {
    localStartTime: w.localStartTime.slice(0, 5),
    localEndTime: w.localEndTime.slice(0, 5),
    daysOfWeek: w.daysOfWeek,
    activeStart: isoToLocalInput(w.activeStart),
    activeEndInput: w.activeEnd === null ? '' : isoToLocalInput(w.activeEnd),
    indefinite: w.activeEnd === null,
    joinCodeScopes: w.joinCodeScopes,
    transcriptionProviderId: w.transcriptionProviderId,
    transcriptionStreamConfig: JSON.stringify(
      w.transcriptionStreamConfig ?? {},
    ),
  };
}

interface AutoWindowDialogProps {
  roomUid: string;
  window: AutoSessionWindow | null;
  onClose: () => void;
  onSaved: () => void;
}

const AutoWindowDialog = ({
  roomUid,
  window: autoWindow,
  onClose,
  onSaved,
}: AutoWindowDialogProps) => {
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<AutoWindowFormState>(() =>
    autoWindow
      ? windowToFormState(autoWindow)
      : {
          localStartTime: '09:00',
          localEndTime: '10:00',
          daysOfWeek: [],
          activeStart: '',
          activeEndInput: '',
          indefinite: true,
          joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: '{}',
        },
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [daysError, setDaysError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  const handleSubmit = () => {
    setJsonError(null);
    if (form.daysOfWeek.length === 0) {
      setDaysError(true);
      showError('Select at least one day of week.');
      return;
    }
    const activeStartIso = localInputToIso(form.activeStart);
    if (activeStartIso === null) {
      showError('Enter a valid start date/time.');
      return;
    }
    const activeStartChanged = activeStartIso !== autoWindow?.activeStart;
    if (
      activeStartChanged &&
      new Date(activeStartIso).getTime() <= Date.now()
    ) {
      showError('Active start must be in the future.');
      return;
    }
    let activeEndIso: string | null = null;
    if (!form.indefinite) {
      activeEndIso = localInputToIso(form.activeEndInput);
      if (activeEndIso === null) {
        showError('Enter a valid end date/time, or mark this indefinite.');
        return;
      }
    }
    let transcriptionStreamConfig: unknown;
    try {
      transcriptionStreamConfig = JSON.parse(form.transcriptionStreamConfig);
    } catch {
      setJsonError('Invalid JSON.');
      return;
    }

    setSubmitting(true);
    setMisconfigured(false);

    if (autoWindow === null) {
      const body: CreateAutoWindowBody = {
        roomUid,
        localStartTime: form.localStartTime,
        localEndTime: form.localEndTime,
        daysOfWeek: form.daysOfWeek,
        activeStart: activeStartIso,
        activeEnd: activeEndIso,
        joinCodeScopes: form.joinCodeScopes,
        transcriptionProviderId: form.transcriptionProviderId,
        transcriptionStreamConfig,
      };
      adminApi
        .createAutoWindow(body)
        .then(() => {
          showSuccess('Auto-session window created.');
          onSaved();
        })
        .catch((err: unknown) => {
          if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
            setMisconfigured(true);
          } else {
            showError(errorMessage(err, 'Failed to create window.'));
          }
        })
        .finally(() => {
          setSubmitting(false);
        });
    } else {
      const body: UpdateAutoWindowBody = {
        windowUid: autoWindow.uid,
        ...diffAutoWindowUpdate(autoWindow, {
          localStartTime: form.localStartTime,
          localEndTime: form.localEndTime,
          daysOfWeek: form.daysOfWeek,
          activeStart: activeStartIso,
          activeEnd: activeEndIso,
          joinCodeScopes: form.joinCodeScopes,
          transcriptionProviderId: form.transcriptionProviderId,
          transcriptionStreamConfig,
        }),
      };
      adminApi
        .updateAutoWindow(body)
        .then(() => {
          showSuccess('Auto-session window updated.');
          onSaved();
        })
        .catch((err: unknown) => {
          if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
            setMisconfigured(true);
          } else {
            showError(errorMessage(err, 'Failed to update window.'));
          }
        })
        .finally(() => {
          setSubmitting(false);
        });
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {autoWindow === null
          ? 'New auto-session window'
          : 'Edit auto-session window'}
      </DialogTitle>
      <DialogContent>
        {misconfigured && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Admin backend misconfiguration — an operator must check the
            server&apos;s ADMIN_API_KEY.
          </Alert>
        )}
        <Stack direction="row" spacing={2}>
          <TextField
            label="Local start time"
            type="time"
            value={form.localStartTime}
            onChange={(e) => {
              setForm((f) => ({ ...f, localStartTime: e.target.value }));
            }}
            margin="normal"
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="Local end time"
            type="time"
            value={form.localEndTime}
            onChange={(e) => {
              setForm((f) => ({ ...f, localEndTime: e.target.value }));
            }}
            margin="normal"
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Stack>
        <MultiSelectField
          label="Days of week"
          options={DAYS_OF_WEEK}
          value={form.daysOfWeek}
          onChange={(v) => {
            setForm((f) => ({ ...f, daysOfWeek: v }));
            setDaysError(false);
          }}
          disabled={false}
          error={daysError}
          helperText={daysError ? 'Select at least one day of week.' : ''}
        />
        <TextField
          label="Active start"
          type="datetime-local"
          value={form.activeStart}
          onChange={(e) => {
            setForm((f) => ({ ...f, activeStart: e.target.value }));
          }}
          margin="normal"
          fullWidth
          helperText="Must be in the future. Interpreted in your browser's local time zone."
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={form.indefinite}
              onChange={(e) => {
                setForm((f) => ({ ...f, indefinite: e.target.checked }));
              }}
            />
          }
          label="No end date (indefinite)"
        />
        {!form.indefinite && (
          <TextField
            label="Active end"
            type="datetime-local"
            value={form.activeEndInput}
            onChange={(e) => {
              setForm((f) => ({ ...f, activeEndInput: e.target.value }));
            }}
            margin="normal"
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
          />
        )}
        <MultiSelectField
          label="Join code scopes"
          options={SCOPES}
          value={form.joinCodeScopes}
          onChange={(v) => {
            setForm((f) => ({ ...f, joinCodeScopes: v }));
          }}
          disabled={false}
        />
        <TextField
          label="Transcription provider ID"
          value={form.transcriptionProviderId}
          onChange={(e) => {
            setForm((f) => ({ ...f, transcriptionProviderId: e.target.value }));
          }}
          fullWidth
          margin="normal"
        />
        <JsonConfigField
          value={form.transcriptionStreamConfig}
          onChange={(v) => {
            setForm((f) => ({ ...f, transcriptionStreamConfig: v }));
          }}
          error={jsonError}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

interface OnDemandFormState {
  name: string;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: string;
}

interface OnDemandDialogProps {
  roomUid: string;
  onClose: () => void;
  onCreated: (sessionUid: string) => void;
}

const OnDemandDialog = ({
  roomUid,
  onClose,
  onCreated,
}: OnDemandDialogProps) => {
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<OnDemandFormState>({
    name: '',
    joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: '{}',
  });
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  const handleSubmit = () => {
    setJsonError(null);
    let transcriptionStreamConfig: unknown;
    try {
      transcriptionStreamConfig = JSON.parse(form.transcriptionStreamConfig);
    } catch {
      setJsonError('Invalid JSON.');
      return;
    }
    const body: CreateOnDemandSessionBody = {
      roomUid,
      name: form.name,
      joinCodeScopes: form.joinCodeScopes,
      transcriptionProviderId: form.transcriptionProviderId,
      transcriptionStreamConfig,
    };
    setSubmitting(true);
    setMisconfigured(false);
    adminApi
      .createOnDemandSession(body)
      .then((created) => {
        showSuccess('Session started.');
        onCreated(created.uid);
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to start session.'));
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Start a session now</DialogTitle>
      <DialogContent>
        {misconfigured && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Admin backend misconfiguration — an operator must check the
            server&apos;s ADMIN_API_KEY.
          </Alert>
        )}
        <TextField
          label="Name"
          value={form.name}
          onChange={(e) => {
            setForm((f) => ({ ...f, name: e.target.value }));
          }}
          fullWidth
          margin="normal"
          autoFocus
        />
        <MultiSelectField
          label="Join code scopes"
          options={SCOPES}
          value={form.joinCodeScopes}
          onChange={(v) => {
            setForm((f) => ({ ...f, joinCodeScopes: v }));
          }}
          disabled={false}
        />
        <TextField
          label="Transcription provider ID"
          value={form.transcriptionProviderId}
          onChange={(e) => {
            setForm((f) => ({ ...f, transcriptionProviderId: e.target.value }));
          }}
          fullWidth
          margin="normal"
        />
        <JsonConfigField
          value={form.transcriptionStreamConfig}
          onChange={(v) => {
            setForm((f) => ({ ...f, transcriptionStreamConfig: v }));
          }}
          error={jsonError}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={submitting || form.name.trim() === ''}
        >
          {submitting ? 'Starting…' : 'Start session'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export const RoomSchedulingPage = () => {
  const { roomUid } = useParams<{ roomUid: string }>();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const [autoToggling, setAutoToggling] = useState(false);

  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] =
    useState<SessionSchedule | null>(null);
  const [deleteScheduleUid, setDeleteScheduleUid] = useState<string | null>(
    null,
  );
  const [deletingSchedule, setDeletingSchedule] = useState(false);

  const [windowDialogOpen, setWindowDialogOpen] = useState(false);
  const [editingWindow, setEditingWindow] = useState<AutoSessionWindow | null>(
    null,
  );
  const [deleteWindowUid, setDeleteWindowUid] = useState<string | null>(null);
  const [deletingWindow, setDeletingWindow] = useState(false);

  const [onDemandOpen, setOnDemandOpen] = useState(false);

  // Fixed once per mount: computing "now" directly during render would make
  // the range drift on every re-render (impure render, flagged by
  // react-hooks/purity and @eslint-react/purity).
  const [rangeFrom, rangeTo] = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const forward = new Date(
      to.getTime() + RANGE_DAYS * 24 * 60 * 60 * 1000,
    );
    return [from.toISOString(), forward.toISOString()];
  }, []);

  // "now" for the active-session classification in the sessions table. Updated
  // on the same cadence as the session poll below so the "active" chip stays
  // current without an impure `Date.now()` during render.
  const [now, setNow] = useState(() => Date.now());

  const {
    data: room,
    loading,
    error: roomError,
    reload: reloadRoom,
  } = useAsyncData<Room>(
    () =>
      roomUid === undefined
        ? Promise.reject(new ApiError('NOT_FOUND', 'No room id.', 404))
        : adminApi.roomDetail(roomUid).then((res) => res.room),
    [roomUid],
  );

  const {
    data: schedulesData,
    loading: schedulesLoading,
    error: schedulesError,
    reload: reloadSchedules,
  } = useAsyncData<SessionSchedule[]>(
    () =>
      roomUid === undefined
        ? Promise.resolve([])
        : adminApi
            .listSchedules({ roomUid, from: rangeFrom, to: rangeTo })
            .then((res) => res.items),
    [roomUid],
  );
  const schedules = schedulesData ?? [];

  const {
    data: windowsData,
    loading: windowsLoading,
    error: windowsError,
    reload: reloadWindows,
  } = useAsyncData<AutoSessionWindow[]>(
    () =>
      roomUid === undefined
        ? Promise.resolve([])
        : adminApi
            .listAutoWindows({ roomUid, from: rangeFrom, to: rangeTo })
            .then((res) => res.items),
    [roomUid],
  );
  const windows = windowsData ?? [];

  // Live session rows (SCHEDULED/ON_DEMAND/AUTO) overlapping the range. Unlike
  // schedules and windows, these include on-demand and AUTO sessions, which
  // have no parent schedule and were previously invisible on this page.
  const {
    data: sessionsData,
    loading: sessionsLoading,
    error: sessionsError,
    reload: reloadSessions,
  } = useAsyncData<Session[]>(
    () =>
      roomUid === undefined
        ? Promise.resolve([])
        : adminApi
            .listSessions({ roomUid, from: rangeFrom, to: rangeTo })
            .then((res) => res.items),
    [roomUid],
  );
  const sessions = sessionsData ?? [];

  // Poll the session list so a session created or started elsewhere (by the
  // auto-session reconciler, or by another operator) appears without a manual
  // reload. Paused when the tab is hidden to avoid hammering a backgrounded
  // page. The schedule/window lists are slower-moving and reload on mutation.
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === 'visible') {
        reloadSessions();
        setNow(Date.now());
      }
    };
    const id = window.setInterval(poll, SESSION_POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [reloadSessions]);

  // Banner is derived from the room load; a misconfiguration raised by the
  // auto-session toggle surfaces as a toast instead (see handleToggleAuto).
  const misconfigured = isApiErrorCode(roomError, 'BACKEND_MISCONFIGURATION');

  // Each load's non-misconfiguration failure is surfaced as a toast, once per
  // error (schedule/window misconfigurations stay silent, as before).
  useEffect(() => {
    if (
      roomError !== null &&
      !isApiErrorCode(roomError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(errorMessage(roomError, 'Failed to load room.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [roomError]);
  useEffect(() => {
    if (
      schedulesError !== null &&
      !isApiErrorCode(schedulesError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(errorMessage(schedulesError, 'Failed to load schedules.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [schedulesError]);
  useEffect(() => {
    if (
      windowsError !== null &&
      !isApiErrorCode(windowsError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(
        errorMessage(windowsError, 'Failed to load auto-session windows.'),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [windowsError]);
  useEffect(() => {
    if (
      sessionsError !== null &&
      !isApiErrorCode(sessionsError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(errorMessage(sessionsError, 'Failed to load sessions.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [sessionsError]);

  const handleToggleAuto = (_e: SyntheticEvent, checked: boolean) => {
    if (roomUid === undefined || room === null) return;
    setAutoToggling(true);
    adminApi
      .updateRoomScheduleConfig({ roomUid, autoSessionEnabled: checked })
      .then(() => {
        reloadRoom();
        showSuccess(
          checked ? 'Auto-sessions enabled.' : 'Auto-sessions disabled.',
        );
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to update auto-session setting.'));
      })
      .finally(() => {
        setAutoToggling(false);
      });
  };

  const handleDeleteSchedule = () => {
    if (deleteScheduleUid === null) return;
    setDeletingSchedule(true);
    adminApi
      .deleteSchedule(deleteScheduleUid)
      .then(() => {
        showSuccess('Schedule deleted.');
        reloadSchedules();
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to delete schedule.'));
      })
      .finally(() => {
        setDeletingSchedule(false);
        setDeleteScheduleUid(null);
      });
  };

  const handleDeleteWindow = () => {
    if (deleteWindowUid === null) return;
    setDeletingWindow(true);
    adminApi
      .deleteAutoWindow(deleteWindowUid)
      .then(() => {
        showSuccess('Auto-session window deleted.');
        reloadWindows();
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to delete window.'));
      })
      .finally(() => {
        setDeletingWindow(false);
        setDeleteWindowUid(null);
      });
  };

  if (loading && room === null) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress aria-label="Loading room" />
      </Box>
    );
  }

  if (room === null) {
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

  return (
    <Box>
      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}
      <Typography variant="h5" component="h1" gutterBottom>
        Scheduling — {room.name}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
          mb: 2,
        }}
      >
        All times below are shown in this room&apos;s timezone ({room.timezone}
        ).
      </Typography>
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Grid
            container
            spacing={2}
            sx={{
              alignItems: 'center',
            }}
          >
            <Grid size={{ xs: 12, sm: 8 }}>
              <Typography variant="body1">Auto-sessions</Typography>
              <Typography
                variant="body2"
                sx={{
                  color: 'text.secondary',
                }}
              >
                When enabled, auto-session windows produce AUTO sessions to fill
                any gaps left by scheduled/on-demand sessions.
              </Typography>
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }} sx={{ textAlign: { sm: 'right' } }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={room.autoSessionEnabled}
                    disabled={autoToggling}
                    onChange={handleToggleAuto}
                  />
                }
                label={room.autoSessionEnabled ? 'Enabled' : 'Disabled'}
              />
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
        <Box>
          <Typography variant="h6" component="h2">
            Schedules
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            Showing occurrences between{' '}
            {formatInRoomTz(rangeFrom, room.timezone)} and{' '}
            {formatInRoomTz(rangeTo, room.timezone)} (next {RANGE_DAYS} days).
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setEditingSchedule(null);
            setScheduleDialogOpen(true);
          }}
        >
          New schedule
        </Button>
      </Box>
      <TableContainer component={Paper} sx={{ mb: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Frequency</TableCell>
              <TableCell>Days</TableCell>
              <TableCell>Local time</TableCell>
              <TableCell>Active start</TableCell>
              <TableCell>Active end</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {schedulesLoading ? (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={28} aria-label="Loading schedules" />
                </TableCell>
              </TableRow>
            ) : schedules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No schedules in this range.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              schedules.map((s) => (
                <TableRow key={s.uid}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>{s.frequency}</TableCell>
                  <TableCell>
                    {s.daysOfWeek ? s.daysOfWeek.join(', ') : '—'}
                  </TableCell>
                  <TableCell>
                    {s.localStartTime.slice(0, 5)}–{s.localEndTime.slice(0, 5)}
                  </TableCell>
                  <TableCell>
                    {formatInRoomTz(s.activeStart, room.timezone)}
                  </TableCell>
                  <TableCell>
                    {s.activeEnd === null
                      ? 'Indefinite'
                      : formatInRoomTz(s.activeEnd, room.timezone)}
                  </TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{
                        justifyContent: 'flex-end',
                      }}
                    >
                      <Button
                        size="small"
                        onClick={() => {
                          setEditingSchedule(s);
                          setScheduleDialogOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => {
                          setDeleteScheduleUid(s.uid);
                        }}
                      >
                        Delete
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Box>
          <Typography variant="h6" component="h2">
            Auto-session windows
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            Showing occurrences between{' '}
            {formatInRoomTz(rangeFrom, room.timezone)} and{' '}
            {formatInRoomTz(rangeTo, room.timezone)} (next {RANGE_DAYS} days).
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setEditingWindow(null);
            setWindowDialogOpen(true);
          }}
        >
          New window
        </Button>
      </Box>
      <TableContainer component={Paper} sx={{ mb: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Days</TableCell>
              <TableCell>Local time</TableCell>
              <TableCell>Active start</TableCell>
              <TableCell>Active end</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {windowsLoading ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <CircularProgress
                    size={28}
                    aria-label="Loading auto-session windows"
                  />
                </TableCell>
              </TableRow>
            ) : windows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No auto-session windows in this range.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              windows.map((w) => (
                <TableRow key={w.uid}>
                  <TableCell>{w.daysOfWeek.join(', ')}</TableCell>
                  <TableCell>
                    {w.localStartTime.slice(0, 5)}–{w.localEndTime.slice(0, 5)}
                  </TableCell>
                  <TableCell>
                    {formatInRoomTz(w.activeStart, room.timezone)}
                  </TableCell>
                  <TableCell>
                    {w.activeEnd === null
                      ? 'Indefinite'
                      : formatInRoomTz(w.activeEnd, room.timezone)}
                  </TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{
                        justifyContent: 'flex-end',
                      }}
                    >
                      <Button
                        size="small"
                        onClick={() => {
                          setEditingWindow(w);
                          setWindowDialogOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => {
                          setDeleteWindowUid(w.uid);
                        }}
                      >
                        Delete
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Box>
          <Typography variant="h6" component="h2">
            Sessions
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            Live session rows (scheduled, on-demand, and auto) overlapping the
            last {LOOKBACK_DAYS} days and next {RANGE_DAYS} days.
          </Typography>
        </Box>
      </Box>
      <TableContainer component={Paper} sx={{ mb: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Effective start</TableCell>
              <TableCell>Effective end</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sessionsLoading ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <CircularProgress
                    size={28}
                    aria-label="Loading sessions"
                  />
                </TableCell>
              </TableRow>
            ) : sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No sessions in this range.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((s) => {
                const isActive =
                  new Date(s.effectiveStart).getTime() <= now &&
                  (s.effectiveEnd === null ||
                    new Date(s.effectiveEnd).getTime() > now);
                return (
                  <TableRow key={s.uid}>
                    <TableCell>{s.name}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Chip size="small" label={s.type} variant="outlined" />
                        {isActive && (
                          <Chip
                            size="small"
                            label="active"
                            color="success"
                          />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {formatInRoomTz(s.effectiveStart, room.timezone)}
                    </TableCell>
                    <TableCell>
                      {s.effectiveEnd === null
                        ? 'Open-ended'
                        : formatInRoomTz(s.effectiveEnd, room.timezone)}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() => {
                          void navigate(`/sessions/${s.uid}`);
                        }}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          On-demand session
        </Typography>
        <Button
          variant="outlined"
          onClick={() => {
            setOnDemandOpen(true);
          }}
        >
          Start a session now
        </Button>
      </Box>
      {scheduleDialogOpen && (
        <ScheduleDialog
          roomUid={room.uid}
          schedule={editingSchedule}
          onClose={() => {
            setScheduleDialogOpen(false);
          }}
          onSaved={() => {
            setScheduleDialogOpen(false);
            reloadSchedules();
          }}
        />
      )}
      {windowDialogOpen && (
        <AutoWindowDialog
          roomUid={room.uid}
          window={editingWindow}
          onClose={() => {
            setWindowDialogOpen(false);
          }}
          onSaved={() => {
            setWindowDialogOpen(false);
            reloadWindows();
          }}
        />
      )}
      {onDemandOpen && (
        <OnDemandDialog
          roomUid={room.uid}
          onClose={() => {
            setOnDemandOpen(false);
          }}
          onCreated={(sessionUid) => {
            setOnDemandOpen(false);
            reloadSessions();
            void navigate(`/sessions/${sessionUid}`);
          }}
        />
      )}
      <ConfirmDialog
        open={deleteScheduleUid !== null}
        title="Delete schedule"
        message="This deletes the schedule and its future occurrences."
        confirmLabel="Delete"
        confirmColor="error"
        loading={deletingSchedule}
        onConfirm={handleDeleteSchedule}
        onClose={() => {
          setDeleteScheduleUid(null);
        }}
      />
      <ConfirmDialog
        open={deleteWindowUid !== null}
        title="Delete auto-session window"
        message="This deletes the auto-session window and stops it from producing further AUTO sessions."
        confirmLabel="Delete"
        confirmColor="error"
        loading={deletingWindow}
        onConfirm={handleDeleteWindow}
        onClose={() => {
          setDeleteWindowUid(null);
        }}
      />
    </Box>
  );
};
