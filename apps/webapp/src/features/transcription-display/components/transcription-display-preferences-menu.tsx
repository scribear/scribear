import SubtitlesIcon from '@mui/icons-material/Subtitles';
import Button from '@mui/material/Button';

import { DrawerMenuGroup } from '#src/components/ui/drawer-menu-group';
import { useAppDispatch } from '#src/stores/use-redux';

import { resetTranscriptionDisplayPreferences } from '../stores/transcription-display-preferences-slice';
import { FontSizeControl } from './preference-controls/font-size-control';
import { LineHeightControl } from './preference-controls/line-height-control';
import { NumDisplayLinesControl } from './preference-controls/num-display-lines-control';
import { VerticalPositionControl } from './preference-controls/vertical-position-control';
import { WordSpacingControl } from './preference-controls/word-spacing-control';

export const TranscriptionDisplayPreferencesMenu = () => {
  const dispatch = useAppDispatch();
  return (
    <DrawerMenuGroup summary="Transcription Text" icon={<SubtitlesIcon />}>
      <FontSizeControl />
      <LineHeightControl />
      <VerticalPositionControl />
      <NumDisplayLinesControl />
      <WordSpacingControl />
      <Button
        onClick={() => {
          dispatch(resetTranscriptionDisplayPreferences());
        }}
      >
        Reset To Default
      </Button>
    </DrawerMenuGroup>
  );
};
