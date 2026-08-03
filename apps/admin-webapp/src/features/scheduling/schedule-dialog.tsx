import { useState } from 'react';

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import TextField from '@mui/material/TextField';

import type { SessionSchedule } from '@scribear/session-manager-schema';

import type {
  CreateScheduleBody,
  DayOfWeek,
  ScheduleFrequency,
  SessionScope,
  UpdateScheduleBody,
} from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';

import {
  JsonConfigField,
  LocalTimeRangeFields,
  MultiSelectField,
} from './scheduling-form-fields';
import {
  DAYS_OF_WEEK,
  SCOPES,
  diffScheduleUpdate,
  isoToLocalInput,
  localInputToIso,
} from './scheduling-form-helpers';

const FREQUENCIES: readonly ScheduleFrequency[] = [
  'ONCE',
  'WEEKLY',
  'BIWEEKLY',
];

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

export interface ScheduleDialogProps {
  roomUid: string;
  /** Room name, shown alongside its timezone on the local-time fields. */
  roomName: string;
  /** The room's IANA zone — the clock the local start/end times are read in. */
  roomTimezone: string;
  schedule: SessionSchedule | null;
  onClose: () => void;
  onSaved: () => void;
}

export const ScheduleDialog = ({
  roomUid,
  roomName,
  roomTimezone,
  schedule,
  onClose,
  onSaved,
}: ScheduleDialogProps) => {
  const { showSuccess, showError, showApiError } = useToast();
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
            showApiError(err, 'Failed to create schedule.');
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
            showApiError(err, 'Failed to update schedule.');
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
        <LocalTimeRangeFields
          startTime={form.localStartTime}
          endTime={form.localEndTime}
          onStartChange={(v) => {
            setForm((f) => ({ ...f, localStartTime: v }));
          }}
          onEndChange={(v) => {
            setForm((f) => ({ ...f, localEndTime: v }));
          }}
          roomName={roomName}
          roomTimezone={roomTimezone}
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
          disabled={submitting || form.name.trim() === ''}
        >
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
