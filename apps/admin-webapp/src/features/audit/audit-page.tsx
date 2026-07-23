import { useEffect, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import type { AuditRow } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';

const LIMIT_OPTIONS = [50, 100, 200] as const;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export const AuditPage = () => {
  const { showError } = useToast();
  const [items, setItems] = useState<AuditRow[]>([]);
  const [limit, setLimit] = useState<number>(50);
  const [loading, setLoading] = useState(true);
  const [misconfigured, setMisconfigured] = useState(false);

  useEffect(() => {
    const alive = { current: true };
    // eslint-disable-next-line react-hooks/set-state-in-effect, @eslint-react/set-state-in-effect -- tracked in REVIEW-EFFECT-SETState.md
    setLoading(true);
    adminApi
      .listAudit(limit)
      .then((res) => {
        if (!alive.current) return;
        setMisconfigured(false);
        setItems(res.items);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to load audit log.'));
        }
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [limit]);

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 2,
        }}
      >
        <Typography variant="h5" component="h1">
          Audit log
        </Typography>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel id="audit-limit-label">Rows</InputLabel>
          <Select
            labelId="audit-limit-label"
            label="Rows"
            value={String(limit)}
            onChange={(e: SelectChangeEvent) => {
              setLimit(Number(e.target.value));
            }}
          >
            {LIMIT_OPTIONS.map((n) => (
              <MenuItem key={n} value={String(n)}>
                {n}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Time</TableCell>
              <TableCell>Actor</TableCell>
              <TableCell>Action</TableCell>
              <TableCell>Target</TableCell>
              <TableCell>Result</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Request ID</TableCell>
              <TableCell>Params</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">
                    No audit entries found.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              items.map((row) => {
                const isSuccess = row.result.toLowerCase() === 'success';
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      {new Date(row.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {row.actorSubject} ({row.actorProvider})
                    </TableCell>
                    <TableCell>{row.action}</TableCell>
                    <TableCell>{row.target ?? '—'}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={row.result}
                        color={isSuccess ? 'success' : 'error'}
                      />
                    </TableCell>
                    <TableCell>{row.statusCode ?? '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {row.requestId ?? '—'}
                    </TableCell>
                    <TableCell
                      sx={{
                        fontFamily: 'monospace',
                        fontSize: 12,
                        maxWidth: 320,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {JSON.stringify(row.paramsSummary)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
