import { useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

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

import {
  JsonConfigField,
  LocalTimeRangeFields,
  MultiSelectField,
} from './scheduling-form-fields';
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
  /** Room name, shown alongside its timezone on the local-time fields. */
  roomName: string;
  /** The room's IANA zone — the clock the local start/end times are read in. */
  roomTimezone: string;
  /**
   * The room's auto-session master switch. A window on a room with this off is
   * stored and listed but produces no sessions at all (the reconciler reads
   * zero windows), so the dialog has to say which of the two states the room
   * is in — and offer to flip it — rather than saving in silence.
   */
  autoSessionEnabled: boolean;
  window: AutoSessionWindow | null;
  onClose: () => void;
  onSaved: () => void;
}

export const AutoWindowDialog = ({
  roomUid,
  roomName,
  roomTimezone,
  autoSessionEnabled,
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
  // Seeded from the room, same as the kiosk wizard's schedule step: when the
  // master switch is off the offer to turn it on is pre-accepted, since a
  // window saved without it does nothing.
  const [enableAutoSessions, setEnableAutoSessions] = useState(
    () => !autoSessionEnabled,
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

    const creating = autoWindow === null;
    let saved: Promise<AutoSessionWindow>;
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
      saved = adminApi.createAutoWindow(body);
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
      saved = adminApi.updateAutoWindow(body);
    }
    const alsoEnable = enableAutoSessions && !autoSessionEnabled;

    saved
      .then(() => {
        if (!alsoEnable) return null;
        // The master switch is what actually makes the window produce
        // sessions, so a failure here is reported on its own.
        return adminApi
          .updateRoomScheduleConfig({ roomUid, autoSessionEnabled: true })
          .then(() => null)
          .catch((err: unknown) => {
            showError(
              errorMessage(
                err,
                'Window saved, but auto-sessions could not be enabled for the room.',
              ),
            );
            return null;
          });
      })
      .then(() => {
        showSuccess(
          creating
            ? 'Auto-session window created.'
            : 'Auto-session window updated.',
        );
        onSaved();
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(
            errorMessage(
              err,
              creating
                ? 'Failed to create window.'
                : 'Failed to update window.',
            ),
          );
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
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
        {autoSessionEnabled ? (
          <Alert severity="success" sx={{ mt: 2 }}>
            Auto-sessions are enabled for this room, so this window takes effect
            as soon as you save.
          </Alert>
        ) : (
          <Box sx={{ mt: 2 }}>
            <Alert severity="warning">
              Auto-sessions are turned off for this room, so this window will
              not produce any sessions until they are turned on.
            </Alert>
            <FormControlLabel
              control={
                <Checkbox
                  checked={enableAutoSessions}
                  onChange={(e) => {
                    setEnableAutoSessions(e.target.checked);
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
              {enableAutoSessions
                ? "This room's master switch is off. Saving will turn it on."
                : 'Leaving this off saves the window but produces no sessions until the master switch is turned on from this page.'}
            </Typography>
          </Box>
        )}
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
