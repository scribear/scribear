import { useEffect, useState } from 'react';

import Autocomplete from '@mui/material/Autocomplete';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';

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
  const [searchFailed, setSearchFailed] = useState(false);

  useEffect(() => {
    const alive = { current: true };
    adminApi
      .listRooms({ search: inputValue, limit: 25 })
      .then((res) => {
        if (!alive.current) return;
        setSearchFailed(false);
        setOptions(res.items);
      })
      .catch(() => {
        // The error object itself is not kept: this is a search-as-you-type
        // control, and the only thing the operator can do about any cause is
        // type again. What they must NOT see is the previous "no rooms match"
        // wording, which would report a failed search as an empty result —
        // so the flag below rewrites the empty-list text and marks the field.
        if (alive.current) setSearchFailed(true);
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
      noOptionsText={
        searchFailed
          ? 'Could not search rooms — the admin server did not answer.'
          : 'No rooms match.'
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label="Rooms"
          placeholder="Search rooms…"
          error={searchFailed}
          // Not colour alone (WCAG SC 1.4.1): the helper text says it, and it
          // names the next action rather than leaving a silently stale list.
          helperText={
            searchFailed
              ? 'Could not search rooms — the admin server did not answer. Any rooms listed are from an earlier search. Edit your search to try again.'
              : undefined
          }
        />
      )}
    />
  );
};
