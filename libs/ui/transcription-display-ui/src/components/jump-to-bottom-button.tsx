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
}

/**
 * Icon button that scrolls the transcription view to the bottom.
 */
export const JumpToBottomButton = ({
  visible,
  onClick,
}: JumpToBottomButtonProps) => {
  return (
    <IconButton
      color="transcriptionColor"
      onClick={onClick}
      sx={{
        visibility: visible ? 'visible' : 'hidden',
        alignSelf: 'end',
        marginLeft: 2,
        border: 'solid',
        borderWidth: '0.25em',
        borderColor: (theme) => theme.palette.primary.main,
      }}
    >
      <KeyboardDoubleArrowDownIcon fontSize="inherit" />
    </IconButton>
  );
};
