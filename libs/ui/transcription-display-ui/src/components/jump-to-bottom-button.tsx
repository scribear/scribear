import KeyboardDoubleArrowDownIcon from '@mui/icons-material/KeyboardDoubleArrowDown';
import IconButton from '@mui/material/IconButton';

/**
 * Props for {@link JumpToBottomButton}.
 */
interface JumpToBottomButtonProps {
  // Whether the button is visible; hidden when auto-scroll is active.
  visible: boolean;
  // Called when the button is clicked to scroll the transcription view to the bottom.
  onClick: () => void;
  // Accessible name. Defaults to the transcript wording. Override it wherever a
  // second caption region is on screen at the same time - the kiosk and client
  // apps mount the transcript and the translated captions together, and two
  // buttons with the same accessible name give a screen-reader user no way to
  // tell which region they are about to jump.
  label?: string;
}

/**
 * Icon button that scrolls the transcription view to the bottom.
 */
export const JumpToBottomButton = ({
  visible,
  onClick,
  label = 'Jump to latest transcription',
}: JumpToBottomButtonProps) => {
  return (
    <IconButton
      color="transcriptionColor"
      onClick={onClick}
      aria-label={label}
      sx={{
        visibility: visible ? 'visible' : 'hidden',
        alignSelf: 'end',
        marginLeft: 2,
        border: 'solid',
        borderWidth: '0.25em',
        // Use the transcription color (which clears contrast against the
        // background) rather than the accent, whose 3:1 non-text contrast fails
        // in the Default theme and many presets. SC 1.4.11. The palette
        // augmentation types this slot loosely, but CustomThemeProvider always
        // sets `.main`; fall back to the accent if somehow absent.
        borderColor: (theme) =>
          (theme.palette.transcriptionColor as { main: string } | undefined)
            ?.main ?? theme.palette.primary.main,
      }}
    >
      <KeyboardDoubleArrowDownIcon fontSize="inherit" />
    </IconButton>
  );
};
