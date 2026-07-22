import { useEffect, useState } from 'react';

import Autocomplete from '@mui/material/Autocomplete';
import Chip from '@mui/material/Chip';
import TextField, { type TextFieldProps } from '@mui/material/TextField';

import type { Room } from '@scribear/session-manager-schema';

import { adminApi } from '#src/lib/admin-api';

export interface RoomPickerProps {
  selected: Room[];
  onChange: (rooms: Room[]) => void;
}

/**
 * Searches rooms server-side via `adminApi.listRooms({ search, limit })` as
 * the user types, rather than preloading the full room list — this is what
 * keeps the picker workable at hundreds of rooms.
 */
export const RoomPicker = ({ selected, onChange }: RoomPickerProps) => {
  const [inputValue, setInputValue] = useState('');
  const [options, setOptions] = useState<Room[]>([]);

  useEffect(() => {
    const alive = { current: true };
    adminApi
      .listRooms({ search: inputValue, limit: 25 })
      .then((res) => {
        if (alive.current) setOptions(res.items);
      })
      .catch(() => {
        // Best-effort; leave options as-is on error.
      });
    return () => {
      alive.current = false;
    };
  }, [inputValue]);

  return (
    <Autocomplete
      multiple
      options={options}
      value={selected}
      inputValue={inputValue}
      onInputChange={(_e, v) => {
        setInputValue(v);
      }}
      getOptionLabel={(r) => r.name}
      isOptionEqualToValue={(a, b) => a.uid === b.uid}
      onChange={(_e, rooms) => {
        onChange(rooms);
      }}
      renderValue={(rooms, getItemProps) =>
        rooms.map((room, i) => {
          const { key, ...itemProps } = getItemProps({ index: i });
          return <Chip key={key} label={room.name} {...itemProps} />;
        })
      }
      renderInput={(params) => (
        // MUI's AutocompleteRenderInputParams doesn't line up with
        // TextFieldProps under exactOptionalPropertyTypes (nested optional
        // fields like InputLabelProps.className) — this is a known MUI/TS
        // strictness gap, not an app-level type mismatch.
        <TextField
          {...(params as TextFieldProps)}
          label="Rooms"
          placeholder="Search rooms…"
        />
      )}
    />
  );
};
