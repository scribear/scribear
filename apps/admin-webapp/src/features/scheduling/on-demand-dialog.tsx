import { useState } from 'react';

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';

import type {
  CreateOnDemandSessionBody,
  SessionScope,
} from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';

import { JsonConfigField, MultiSelectField } from './scheduling-form-fields';
import { SCOPES, errorMessage } from './scheduling-form-helpers';

interface OnDemandFormState {
  name: string;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: string;
}

export interface OnDemandDialogProps {
  roomUid: string;
  onClose: () => void;
  onCreated: (sessionUid: string) => void;
}

export const OnDemandDialog = ({
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
