import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import type { DividerProps } from 'react-split-pane';

import { DIVIDER_WIDTH_PX } from '../config/split-screen-config';

interface SplitDividerProps extends DividerProps {
  isOpen: boolean;
  onToggle: () => void;
}

export const SplitDivider = ({
  isOpen,
  onToggle,
  onPointerDown,
  onKeyDown,
}: SplitDividerProps) => {
  return (
    <Box
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      sx={{
        width: `${DIVIDER_WIDTH_PX.toString()}px`,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: isOpen ? 'col-resize' : '',
        backgroundColor: 'primary.main',
        flexShrink: 0,
      }}
    >
      <Tooltip
        title={isOpen ? 'Collapse panel' : 'Expand panel'}
        placement="left"
      >
        <IconButton
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          sx={{ p: 0, color: 'primary.contrastText' }}
        >
          {isOpen ? (
            <ChevronRightIcon fontSize="small" />
          ) : (
            <ChevronLeftIcon fontSize="small" />
          )}
        </IconButton>
      </Tooltip>
    </Box>
  );
};
