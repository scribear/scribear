import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import TextField from '@mui/material/TextField';

interface MultiSelectFieldProps<T extends string> {
  label: string;
  options: readonly T[];
  value: T[];
  onChange: (value: T[]) => void;
  disabled: boolean;
}

export function MultiSelectField<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: MultiSelectFieldProps<T>) {
  const labelId = `multiselect-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <FormControl fullWidth margin="normal" disabled={disabled}>
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
      >
        {options.map((opt) => (
          <MenuItem key={opt} value={opt}>
            <Checkbox checked={value.includes(opt)} />
            <ListItemText primary={opt} />
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

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
