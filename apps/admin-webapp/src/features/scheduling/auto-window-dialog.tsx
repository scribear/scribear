import { useState } from 'react';

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';

import type { AutoSessionWindow } from '@scribear/session-manager-schema';

import type {
  CreateAutoWindowBody,
  DayOfWeek,
  SessionScope,
  UpdateAutoWindowBody,
} from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';

import { JsonConfigField, MultiSelectField } from './scheduling-form-fields';
import {
  DAYS_OF_WEEK,
  SCOPES,
  diffAutoWindowUpdate,
  errorMessage,
  isoToLocalInput,
  localInputToIso,
} from './scheduling-form-helpers';

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

export interface AutoWindowDialogProps {
  roomUid: string;
  window: AutoSessionWindow | null;
  onClose: () => void;
  onSaved: () => void;
}

export const AutoWindowDialog = ({
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
