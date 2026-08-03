import { type SyntheticEvent, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useSearchParams } from 'react-router-dom';
import { Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '#src/features/auth/auth-context';
import {
  type ErrorSeverity,
  errorSeverity,
  loginErrorMessage,
} from '#src/lib/api-error';

export const LoginPage = () => {
  const { status, config, configError, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Severity travels with the message: the login route is rate limited to 5
  // attempts a minute, so the most likely repeat failure here is a 429 — which
  // is transient and self-clearing, and must not be shown in the same red
  // alert as "Invalid credentials." or the operator will keep guessing at a
  // password that was never the problem.
  const [error, setError] = useState<{
    message: string;
    severity: ErrorSeverity;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const ssoError = searchParams.get('sso_error');

  if (status === 'authed') {
    return <Navigate to="/" replace />;
  }

  const ssoErrorMessage: Record<string, string> = {
    state_error:
      'Sign-in session expired or was tampered with. Please try again.',
    auth_failed:
      'Authentication failed. Please try again, or contact an operator if this continues.',
    group_rejected:
      'You are not authorized to administer this deployment. Contact an operator if you believe this is an error.',
    config_error:
      'SSO is misconfigured on the server (missing group claim). Contact an operator.',
  };

  const handleSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    void login(username, password)
      .then(() => {
        void navigate('/', { replace: true });
      })
      .catch((err: unknown) => {
        setError({
          message: loginErrorMessage(err),
          severity: errorSeverity(err),
        });
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
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
              mb: 3,
            }}
          >
            Sign in to manage rooms, devices, and kiosks.
          </Typography>

          {error && (
            <Alert severity={error.severity} sx={{ mb: 2 }}>
              {error.message}
            </Alert>
          )}

          {ssoError && ssoErrorMessage[ssoError] && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {ssoErrorMessage[ssoError]}
            </Alert>
          )}

          {configError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              Couldn&apos;t reach the admin server ({configError}). Try
              reloading, or contact an operator if this continues.
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
            <Button
              variant="outlined"
              fullWidth
              size="large"
              onClick={() => {
                const currentPath =
                  window.location.pathname + window.location.search;
                const loginUrl =
                  '/api/admin/v1/auth/sso/login' +
                  (currentPath && currentPath !== '/admin/login'
                    ? `?return_to=${encodeURIComponent(currentPath)}`
                    : '');
                window.location.href = loginUrl;
              }}
            >
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
