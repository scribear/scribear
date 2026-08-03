import { useState } from 'react';

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

import { ErrorState } from '#src/components/error-state';
import { TimezoneNote } from '#src/components/timezone-note';
import { adminApi } from '#src/lib/admin-api';
import { useAsyncData } from '#src/lib/use-async-data';

const LIMIT_OPTIONS = [50, 100, 200] as const;

export const AuditPage = () => {
  const [limit, setLimit] = useState<number>(50);

  const { state, reload } = useAsyncData(
    () => adminApi.listAudit(limit),
    [limit],
  );

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
      <TimezoneNote />
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
            {/* Three outcomes, never two: an unread audit log is not an
                empty one (PLAN-VisibleErrors §5). */}
            {state.status === 'loading' ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            ) : state.status === 'unavailable' ? (
              <TableRow>
                <TableCell colSpan={8} sx={{ py: 2 }}>
                  <ErrorState
                    title="Could not load the audit log."
                    error={state.error}
                    onRetry={reload}
                  />
                </TableCell>
              </TableRow>
            ) : state.data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No audit entries found.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              state.data.items.map((row) => {
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
