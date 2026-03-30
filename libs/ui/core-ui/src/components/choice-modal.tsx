import Box from '@mui/material/Box';
import Button, { type ButtonProps } from '@mui/material/Button';
import Modal from '@mui/material/Modal';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

/**
 * Props for the {@link ChoiceModal} component.
 *
 * @param isOpen Whether the modal is currently visible.
 * @param message Descriptive text displayed at the top of the modal.
 * @param leftColor MUI color variant for the left action button. Defaults to `'error'`.
 * @param rightColor MUI color variant for the right action button. Defaults to `'info'`.
 * @param leftAction Label for the left button. Defaults to `'Cancel'`.
 * @param rightAction Label for the right button.
 * @param onCancel Called when the modal is dismissed (backdrop click or Escape).
 * @param onLeftAction Called when the left button is clicked. Defaults to `onCancel`.
 * @param onRightAction Called when the right button is clicked.
 * @param children Optional content rendered between the message and the action buttons.
 */
interface ChoiceModalProps {
  isOpen: boolean;
  message: string;
  leftColor?: ButtonProps['color'];
  rightColor?: ButtonProps['color'];
  leftAction?: string;
  rightAction: string;
  onCancel: () => void;
  onLeftAction?: () => void;
  onRightAction: () => void;
  children?: React.ReactNode;
}

/**
 * Modal dialog with a configurable left and right action button.
 *
 * Displays a `message` and up to two buttons whose labels, colors, and
 * callbacks are fully customizable. Closing the backdrop calls `onCancel`.
 */
export const ChoiceModal = ({
  isOpen,
  message,
  leftColor = 'error',
  rightColor = 'info',
  leftAction = 'Cancel',
  rightAction,
  onCancel,
  onLeftAction = onCancel,
  onRightAction,
  children,
}: ChoiceModalProps) => {
  return (
    <Modal open={isOpen} onClose={onCancel}>
      <Paper
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '100%',
          maxWidth: 400,
          p: 4,
        }}
      >
        <Typography textAlign="center" pb={4}>
          {message}
        </Typography>
        {children ? <Box sx={{ pb: 4 }}>{children}</Box> : null}
        <Stack direction="row" justifyContent="space-between">
          <Button onClick={onLeftAction} color={leftColor} variant="contained">
            {leftAction}
          </Button>
          <Button
            onClick={onRightAction}
            color={rightColor}
            variant="contained"
          >
            {rightAction}
          </Button>
        </Stack>
      </Paper>
    </Modal>
  );
};
