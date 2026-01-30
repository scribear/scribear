import KeyboardDoubleArrowDownIcon from '@mui/icons-material/KeyboardDoubleArrowDown';
import IconButton from '@mui/material/IconButton';

interface JumpToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
}

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
