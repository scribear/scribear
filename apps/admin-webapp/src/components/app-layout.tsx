import { useState } from 'react';

import DevicesIcon from '@mui/icons-material/Devices';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import HistoryIcon from '@mui/icons-material/History';
import LogoutIcon from '@mui/icons-material/Logout';
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ScienceIcon from '@mui/icons-material/Science';
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
import { OpensInNewTab } from '#src/components/opens-in-new-tab';
import { useAuth } from '#src/features/auth/auth-context';
import { audioMeterHref } from '#src/lib/audio-meter-url';
import { useSettings } from '#src/lib/settings-context';

const DRAWER_WIDTH = 232;

/**
 * The standalone audio meter measures the microphone of the device that opens
 * it, so the link is `target="_blank"` with an `OpenInNewIcon` affordance — an
 * operator clicking it from their laptop gets a new tab (not the room's meter),
 * and the copy makes clear the tool should be run on the source machine. The
 * page needs a secure context (HTTPS or localhost) for `getUserMedia`.
 *
 * Root-relative (`audioMeterHref()`), not `'audio-meter.html'`: this nav sits on
 * every authed route, including nested ones like `/admin/sessions/:uid`, where a
 * relative href would resolve to `/admin/sessions/audio-meter.html`.
 */
interface InternalNavItem {
  label: string;
  to: string;
  icon: React.ReactNode;
}

interface ExternalNavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  external: true;
}

type NavItem = InternalNavItem | ExternalNavItem;

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: <SpaceDashboardIcon /> },
  { label: 'Rooms', to: '/rooms', icon: <MeetingRoomIcon /> },
  { label: 'Devices', to: '/devices', icon: <DevicesIcon /> },
  { label: 'Set up a kiosk', to: '/kiosk-setup', icon: <TabletIcon /> },
  { label: 'Test audio', to: '/test-audio', icon: <ScienceIcon /> },
  { label: 'Audit log', to: '/audit', icon: <HistoryIcon /> },
  { label: 'Deployment Check', to: '/config-check', icon: <FactCheckIcon /> },
  { label: 'Documentation', to: '/documentation', icon: <MenuBookIcon /> },
  {
    label: 'Audio meter (this device)',
    href: audioMeterHref(),
    icon: <GraphicEqIcon />,
    external: true,
  },
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
          {NAV_ITEMS.map((item) =>
            'href' in item ? (
              <ListItemButton
                key={item.href}
                component="a"
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ListItemIcon>{item.icon}</ListItemIcon>
                <ListItemText
                  primary={item.label}
                  slotProps={{
                    primary: { sx: { pr: 0.5 } },
                  }}
                />
                <OpenInNewIcon fontSize="small" color="action" />
                <OpensInNewTab />
              </ListItemButton>
            ) : (
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
            ),
          )}
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, p: 3, width: 0 }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
};
