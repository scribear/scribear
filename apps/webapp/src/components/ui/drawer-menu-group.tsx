import type React from 'react';
import { useState } from 'react';

import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Icon from '@mui/material/Icon';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface DrawerMenuGroupProps {
  summary: string;
  icon: React.ReactNode;
  children?: React.ReactNode;
}

export const DrawerMenuGroup = ({
  icon,
  summary,
  children,
}: DrawerMenuGroupProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ p: 2 }}
      >
        <Stack direction="row" alignItems="center">
          <Stack sx={{ p: 1 }}>
            <Icon color="inherit">{icon}</Icon>
          </Stack>
          <Typography>{summary}</Typography>
        </Stack>

        <IconButton
          onClick={() => {
            setIsOpen(!isOpen);
          }}
        >
          {isOpen ? <ExpandLess /> : <ExpandMore />}
        </IconButton>
      </Stack>
      <Collapse in={isOpen}>
        <Stack sx={{ p: 2 }} direction="column" spacing={1}>
          {children}
        </Stack>
      </Collapse>
      <Divider />
    </Box>
  );
};
