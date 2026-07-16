import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '#src/features/auth/auth-context';

/**
 * Route guard. Shows a spinner while the session is resolving, redirects to
 * /login when anonymous, and renders the protected routes when authenticated.
 */
export const RequireAuth = () => {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (status === 'anon') {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};
