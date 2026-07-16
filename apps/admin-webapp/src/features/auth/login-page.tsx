import { type SyntheticEvent, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '#src/features/auth/auth-context';
import { ApiError } from '#src/lib/api-error';

export const LoginPage = () => {
  const { status, config, login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authed') {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    void login(username, password)
      .then(() => {
        void navigate('/', { replace: true });
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Sign in failed. Please try again.',
        );
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        p: 2,
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 400 }}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" component="h1" gutterBottom>
            ScribeAR Admin
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Sign in to manage rooms, devices, and kiosks.
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {config?.local && (
            <Box component="form" onSubmit={handleSubmit} noValidate>
              <TextField
                label="Username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                }}
                fullWidth
                margin="normal"
                autoComplete="username"
                autoFocus
              />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
                fullWidth
                margin="normal"
                autoComplete="current-password"
              />
              <Button
                type="submit"
                variant="contained"
                fullWidth
                size="large"
                disabled={submitting || username === '' || password === ''}
                sx={{ mt: 2 }}
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </Button>
            </Box>
          )}

          {config?.local && config.sso && <Divider sx={{ my: 2 }}>or</Divider>}

          {config?.sso && (
            <Button variant="outlined" fullWidth size="large" disabled>
              Sign in with Illinois (Azure AD)
            </Button>
          )}

          {config && !config.local && !config.sso && (
            <Alert severity="warning">
              No sign-in methods are configured. Contact an operator.
            </Alert>
          )}
        </CardContent>
      </Card>
    </Box>
  );
};
