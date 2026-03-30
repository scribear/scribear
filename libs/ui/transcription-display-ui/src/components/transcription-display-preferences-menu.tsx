import SubtitlesIcon from '@mui/icons-material/Subtitles';
import Button from '@mui/material/Button';

import { DrawerMenuGroup } from '@scribear/core-ui';

import { FontSizeControl } from './preference-controls/font-size-control.js';
import { LineHeightControl } from './preference-controls/line-height-control.js';
import { NumDisplayLinesControl } from './preference-controls/num-display-lines-control.js';
import { VerticalPositionControl } from './preference-controls/vertical-position-control.js';
import { WordSpacingControl } from './preference-controls/word-spacing-control.js';

/**
 * Bounded display preferences resolved against the current container height.
 */
interface BoundedDisplayPreferences {
  verticalPositionPx: number;
  numDisplayLines: number;
}

/**
 * Min/max pixel bounds for the transcription vertical position, derived from container height.
 */
interface VerticalPositionBoundsPx {
  minVerticalPositionPx: number;
  maxVerticalPositionPx: number;
}

/**
 * Min/max bounds for the number of visible transcription lines, derived from container height.
 */
interface NumDisplayLinesBounds {
  minNumDisplayLines: number;
  maxNumDisplayLines: number;
}

/**
 * Props for {@link TranscriptionDisplayPreferencesMenu}.
 */
export interface TranscriptionDisplayPrefsMenuProps {
  // The current font size in pixels. Passed to FontSizeControl.
  fontSizePx: number;
  // The current line height multiplier. Passed to LineHeightControl.
  lineHeightMultipler: number;
  // The current word spacing in em units. Passed to WordSpacingControl.
  wordSpacingEm: number;
  // Callback to update the font size. Receives the new pixel value.
  setFontSizePx: (value: number) => void;
  // Callback to update the line height multiplier. Receives the new value.
  setLineHeightMultipler: (value: number) => void;
  // Callback to update the word spacing. Receives the new em value.
  setWordSpacingEm: (value: number) => void;
  // Callback to update the target vertical position. Receives the new pixel value.
  setTargetVerticalPositionPx: (value: number) => void;
  // Callback to update the target number of display lines. Receives the new value.
  setTargetDisplayLines: (value: number) => void;
  // Resets all transcription display preferences to their default values.
  resetPreferences: () => void;
  // Returns the current display preferences (vertical position and line count) clamped to the container height.
  getBoundedDisplayPreferences: (
    containerHeightPx: number,
  ) => BoundedDisplayPreferences;
  // Returns the min/max vertical position in pixels given the current container height.
  getVerticalPositionBoundsPx: (
    containerHeightPx: number,
  ) => VerticalPositionBoundsPx;
  // Returns the min/max number of displayable lines given the current container height.
  getNumDisplayLinesBounds: (
    containerHeightPx: number,
  ) => NumDisplayLinesBounds;
}

/**
 * Drawer menu group containing all transcription display preference controls.
 */
export const TranscriptionDisplayPreferencesMenu = ({
  fontSizePx,
  lineHeightMultipler,
  wordSpacingEm,
  setFontSizePx,
  setLineHeightMultipler,
  setWordSpacingEm,
  setTargetVerticalPositionPx,
  setTargetDisplayLines,
  resetPreferences,
  getBoundedDisplayPreferences,
  getVerticalPositionBoundsPx,
  getNumDisplayLinesBounds,
}: TranscriptionDisplayPrefsMenuProps) => {
  return (
    <DrawerMenuGroup summary="Transcription Text" icon={<SubtitlesIcon />}>
      <FontSizeControl fontSizePx={fontSizePx} setFontSizePx={setFontSizePx} />
      <LineHeightControl
        lineHeightMultipler={lineHeightMultipler}
        setLineHeightMultipler={setLineHeightMultipler}
      />
      <VerticalPositionControl
        getVerticalPositionBoundsPx={getVerticalPositionBoundsPx}
        getBoundedDisplayPreferences={getBoundedDisplayPreferences}
        setTargetVerticalPositionPx={setTargetVerticalPositionPx}
      />
      <NumDisplayLinesControl
        getNumDisplayLinesBounds={getNumDisplayLinesBounds}
        getBoundedDisplayPreferences={getBoundedDisplayPreferences}
        setTargetDisplayLines={setTargetDisplayLines}
      />
      <WordSpacingControl
        wordSpacingEm={wordSpacingEm}
        setWordSpacingEm={setWordSpacingEm}
      />
      <Button onClick={resetPreferences}>Reset To Default</Button>
    </DrawerMenuGroup>
  );
};
