import type React from 'react';
import { useId, useState } from 'react';

import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Icon from '@mui/material/Icon';
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
  const contentId = useId();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Box>
      <ButtonBase
        component="button"
        type="button"
        onClick={() => {
          setIsOpen((currentIsOpen) => !currentIsOpen);
        }}
        aria-expanded={isOpen}
        aria-controls={contentId}
        sx={{
          width: '100%',
          p: 2,
          color: 'inherit',
          justifyContent: 'space-between',
          textAlign: 'left',
        }}
      >
        <Stack component="span" direction="row" alignItems="center">
          <Stack component="span" sx={{ p: 1 }}>
            <Icon color="inherit">{icon}</Icon>
          </Stack>
          <Typography component="span">{summary}</Typography>
        </Stack>

        <Box
          component="span"
          aria-hidden="true"
          sx={{ display: 'inline-flex', p: 1 }}
        >
          {isOpen ? <ExpandLess /> : <ExpandMore />}
        </Box>
      </ButtonBase>
      <Collapse id={contentId} in={isOpen}>
        <Stack sx={{ p: 2 }} direction="column" spacing={1}>
          {children}
        </Stack>
      </Collapse>
      <Divider />
    </Box>
  );
};
