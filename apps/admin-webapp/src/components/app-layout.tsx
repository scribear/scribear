import { useState } from 'react';

import DevicesIcon from '@mui/icons-material/Devices';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import HistoryIcon from '@mui/icons-material/History';
import LogoutIcon from '@mui/icons-material/Logout';
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom';
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard';
import TabletIcon from '@mui/icons-material/Tablet';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import FormControlLabel from '@mui/material/FormControlLabel';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Switch from '@mui/material/Switch';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';

import { NavLink, Outlet } from 'react-router-dom';

import { HealthIndicator } from '#src/components/health-indicator';
import { useAuth } from '#src/features/auth/auth-context';
import { useSettings } from '#src/lib/settings-context';

const DRAWER_WIDTH = 232;

const NAV_ITEMS = [
  { label: 'Dashboard', to: '/', icon: <SpaceDashboardIcon /> },
  { label: 'Rooms', to: '/rooms', icon: <MeetingRoomIcon /> },
  { label: 'Devices', to: '/devices', icon: <DevicesIcon /> },
  { label: 'Set up a kiosk', to: '/kiosk-setup', icon: <TabletIcon /> },
  { label: 'Audit log', to: '/audit', icon: <HistoryIcon /> },
  { label: 'Config Check', to: '/config-check', icon: <FactCheckIcon /> },
];

/**
 * Authenticated app shell: top bar (title, health, sign out) + side nav +
 * routed content area.
 */
export const AppLayout = () => {
  const { identity, logout } = useAuth();
  const { showUuids, setShowUuids } = useSettings();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = () => {
    setSigningOut(true);
    void logout().finally(() => {
      setSigningOut(false);
    });
  };

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar
        position="fixed"
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}
      >
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            ScribeAR Admin
          </Typography>
          <HealthIndicator />
          <FormControlLabel
            control={
              <Switch
                size="small"
                color="default"
                checked={showUuids}
                onChange={(_e, checked) => {
                  setShowUuids(checked);
                }}
              />
            }
            label="Show UUIDs"
            sx={{ color: 'inherit', mr: 0 }}
          />
          <Typography variant="body2" sx={{ opacity: 0.85 }}>
            {identity?.displayName ?? ''}
          </Typography>
          <Button
            color="inherit"
            startIcon={<LogoutIcon />}
            onClick={handleSignOut}
            disabled={signingOut}
          >
            Sign out
          </Button>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
          },
        }}
      >
        <Toolbar />
        <Divider />
        <List>
          {NAV_ITEMS.map((item) => (
            <ListItemButton
              key={item.to}
              component={NavLink}
              to={item.to}
              end={item.to === '/'}
              sx={{
                '&.active': {
                  bgcolor: 'action.selected',
                  borderRight: 3,
                  borderColor: 'primary.main',
                },
              }}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, p: 3, width: 0 }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
};
