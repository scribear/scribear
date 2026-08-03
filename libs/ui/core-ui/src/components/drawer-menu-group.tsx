import type React from 'react';
import { useId, useState } from 'react';

import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Icon from '@mui/material/Icon';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

/**
 * Props for the {@link DrawerMenuGroup} component.
 *
 * @param summary Text label shown as the group heading.
 * @param icon Icon element displayed to the left of the summary label.
 * @param children Content revealed when the group is expanded.
 */
interface DrawerMenuGroupProps {
  summary: string;
  icon: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * A collapsible section in a drawer menu, identified by an icon and a summary label.
 *
 * Toggling the expand/collapse button reveals the `children` content beneath the header row.
 * A divider is rendered below the group to visually separate it from adjacent groups.
 */
export const DrawerMenuGroup = ({
  icon,
  summary,
  children,
}: DrawerMenuGroupProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const contentId = useId();

  return (
    <Box>
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          p: 2,
        }}
      >
        <Stack
          direction="row"
          sx={{
            alignItems: 'center',
          }}
        >
          <Stack sx={{ p: 1 }}>
            {/* Decorative leading icon — the summary text is the real label. */}
            <Icon color="inherit" aria-hidden="true">
              {icon}
            </Icon>
          </Stack>
          {/* Group heading. Level is reconciled by the app-wide heading pass (P3):
              app <h1> -> drawer title <h2> -> group summary <h3>. */}
          <Typography component="h3" variant="body1">
            {summary}
          </Typography>
        </Stack>

        <IconButton
          onClick={() => {
            setIsOpen(!isOpen);
          }}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${summary}`}
          aria-expanded={isOpen}
          aria-controls={contentId}
        >
          {isOpen ? <ExpandLess /> : <ExpandMore />}
        </IconButton>
      </Stack>
      <Collapse in={isOpen} id={contentId}>
        <Stack sx={{ p: 2 }} direction="column" spacing={1}>
          {children}
        </Stack>
      </Collapse>
      <Divider />
    </Box>
  );
};
