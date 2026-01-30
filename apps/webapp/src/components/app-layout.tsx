/**
 * Lays out page header, drawer, and content
 */
import { useState } from 'react';

import CloseIcon from '@mui/icons-material/Close';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import MenuIcon from '@mui/icons-material/Menu';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Slide from '@mui/material/Slide';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { type Breakpoint, useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';

import { USER_ACTIVITY_TIMEOUT } from '@/config/contants';
import { useFullscreen } from '@/hooks/use-fullscreen';
import { useInactivity } from '@/hooks/use-inactivity';
import {
  selectIsHeaderHideEnabled,
  toggleHeaderHide,
} from '@/stores/slices/app-layout-preferences-slice';
import { useAppDispatch, useAppSelector } from '@/stores/use-redux';

interface MainLayoutProps {
  children?: React.ReactNode;

  providerSelector?: React.ReactNode;
  headerButtons: React.ReactNode[];
  drawerContent?: React.ReactNode;

  headerBreakpoint?: Breakpoint;
}

export const AppLayout = ({
  children,
  providerSelector,
  headerButtons = [],
  drawerContent,
  headerBreakpoint = 'sm',
}: MainLayoutProps) => {
  const dispatch = useAppDispatch();

  const isHeaderHideEnabled = useAppSelector(selectIsHeaderHideEnabled);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const { isFullscreen, isSupported, toggleFullscreen } = useFullscreen();

  const theme = useTheme();
  const isSplitHeader = useMediaQuery(theme.breakpoints.down(headerBreakpoint));
  const isUserActive = useInactivity(USER_ACTIVITY_TIMEOUT);

  // Menu button and ScribeAR title group
  const MenuTitleGroup = (
    <Stack direction="row" alignItems="center">
      <Tooltip title="Open Menu">
        <IconButton
          color="inherit"
          onClick={() => {
            setIsDrawerOpen(true);
          }}
        >
          <MenuIcon />
        </IconButton>
      </Tooltip>
      <Typography variant="h5" marginLeft={2}>
        ScribeAR
      </Typography>
    </Stack>
  );

  const fullscreenTooltip = isSupported
    ? isFullscreen
      ? 'Exit Fullscreen'
      : 'Fullscreen'
    : 'Fullscreen Not Supported';

  // Buttons for controlling layout (autohide header and fullscreen)
  const LayoutControls = (
    <Stack direction="row">
      <Tooltip
        title={
          isHeaderHideEnabled
            ? 'Disable Header Autohide'
            : 'Enable Header Autohide'
        }
      >
        <IconButton
          color="inherit"
          onClick={() => {
            dispatch(toggleHeaderHide());
          }}
        >
          {isHeaderHideEnabled ? <LockOpenIcon /> : <LockIcon />}
        </IconButton>
      </Tooltip>

      <Tooltip title={fullscreenTooltip}>
        <IconButton
          disabled={!isSupported}
          color="inherit"
          onClick={() => {
            void toggleFullscreen();
          }}
        >
          {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
        </IconButton>
      </Tooltip>
    </Stack>
  );

  // Split header into 2 rows on smaller devices
  const Header = isSplitHeader ? (
    <>
      <Toolbar
        sx={{
          justifyContent: 'space-between',
        }}
      >
        {MenuTitleGroup}
        {LayoutControls}
      </Toolbar>
      <Toolbar
        sx={{
          width: '100%',
          justifyContent: 'space-between',
        }}
      >
        <Box>{providerSelector}</Box>
        <Stack direction="row">{headerButtons}</Stack>
      </Toolbar>
    </>
  ) : (
    <Toolbar
      sx={{
        justifyContent: 'space-between',
      }}
    >
      {MenuTitleGroup}
      <Stack direction="row" alignItems="center">
        <Box>{providerSelector}</Box>
        <Box>{headerButtons}</Box>
        {LayoutControls}
      </Stack>
    </Toolbar>
  );

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
      }}
    >
      <Drawer
        anchor="left"
        open={isDrawerOpen}
        onClose={() => {
          setIsDrawerOpen(false);
        }}
        slotProps={{
          paper: {
            sx: {
              width: '30rem',
              maxWidth: '100%',
            },
          },
        }}
      >
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{
            p: 2,
          }}
        >
          <Typography variant="h5" fontWeight={500}>
            Menu
          </Typography>
          <Tooltip title="Close Menu">
            <IconButton
              color="inherit"
              onClick={() => {
                setIsDrawerOpen(false);
              }}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Stack>
        {drawerContent}
      </Drawer>

      <Slide
        appear={false}
        direction="down"
        in={!isHeaderHideEnabled || isUserActive}
      >
        <AppBar>{Header}</AppBar>
      </Slide>

      <Box component="main">{children}</Box>
    </Box>
  );
};
