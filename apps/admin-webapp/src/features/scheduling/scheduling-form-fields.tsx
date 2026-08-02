import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';

interface MultiSelectFieldProps<T extends string> {
  label: string;
  options: readonly T[];
  value: T[];
  onChange: (value: T[]) => void;
  disabled: boolean;
  error?: boolean;
  helperText?: string;
}

export function MultiSelectField<T extends string>({
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

interface LocalTimeRangeFieldsProps {
  startTime: string;
  endTime: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  /** Room these times belong to, named in the caption. */
  roomName: string;
  /** The room's IANA zone — the clock these two fields are read against. */
  roomTimezone: string;
}

/**
 * The "Local start/end time" pair, with the clock it is read against spelled
 * out.
 *
 * These are wall-clock strings the server resolves in the *room's* timezone,
 * while "Active start"/"Active end" in the same dialogs are read in the
 * browser's. Two clocks in one form: for an operator scheduling a room in
 * another timezone, a mismatch produces no error at any layer — every value is
 * individually valid — just a window at the wrong hour. So the room's zone is
 * named here the same way "Active start"'s helper text names the browser's.
 */
export const LocalTimeRangeFields = ({
  startTime,
  endTime,
  onStartChange,
  onEndChange,
  roomName,
  roomTimezone,
}: LocalTimeRangeFieldsProps) => {
  const helperId = 'local-time-range-helper';
  return (
    <Box>
      <Stack direction="row" spacing={2}>
        <TextField
          label="Local start time"
          type="time"
          value={startTime}
          onChange={(e) => {
            onStartChange(e.target.value);
          }}
          margin="normal"
          fullWidth
          slotProps={{
            inputLabel: { shrink: true },
            htmlInput: { 'aria-describedby': helperId },
          }}
        />
        <TextField
          label="Local end time"
          type="time"
          value={endTime}
          onChange={(e) => {
            onEndChange(e.target.value);
          }}
          margin="normal"
          fullWidth
          slotProps={{
            inputLabel: { shrink: true },
            htmlInput: { 'aria-describedby': helperId },
          }}
        />
      </Stack>
      <FormHelperText id={helperId} sx={{ mx: 1.75 }}>
        Interpreted in {roomName}&apos;s timezone ({roomTimezone}), not your
        browser&apos;s.
      </FormHelperText>
    </Box>
  );
};

/** JSON textarea for `transcriptionStreamConfig`. Parsing happens on submit. */
interface JsonConfigFieldProps {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}

export const JsonConfigField = ({
  value,
  onChange,
  error,
}: JsonConfigFieldProps) => (
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
