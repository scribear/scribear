import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';

import { CopyIconButton } from '#src/components/copy-icon-button';
import { describeApiFailure } from '#src/lib/api-failure';

export interface ErrorStateProps {
  /**
   * What failed, in the page's own words — "Could not load rooms." Doubles as
   * the fallback cause when the error is not an `ApiError`.
   */
  title: string;
  /** The rejection value from `adminApi`. */
  error: unknown;
  /**
   * Re-runs the load. Rendered only when retrying could plausibly succeed:
   * offering "Retry" for an expired session or a wrong ADMIN_API_KEY would be
   * advice we know is wrong (PLAN-VisibleErrors §1).
   */
  onRetry?: () => void;
  sx?: SxProps<Theme>;
}

/**
 * The one error surface for admin pages (PLAN-VisibleErrors §10.1), replacing
 * the hand-rolled `errorMessage(err, fallback)` + auto-hiding toast pairs.
 *
 * Renders three things a toast could not: the **cause**, the **next action**,
 * and the server's **`requestId`** — which `ApiError` has carried since it was
 * written and which nothing displayed. It is `severity="error"` (§10.4:
 * action required), never `warning`; MUI gives that an icon and `role="alert"`,
 * so colour is not the only signal (WCAG SC 1.4.1) and the failure is
 * announced once when it appears. It is deliberately *not* inside an
 * `aria-live` region of its own — these mount on a load failure, not on a
 * poll.
 */
export const ErrorState = ({ title, error, onRetry, sx }: ErrorStateProps) => {
  const { cause, nextAction, retryable, requestId } = describeApiFailure(
    error,
    title,
  );
  const showRetry = onRetry !== undefined && retryable;

  return (
    <Alert
      severity="error"
      sx={sx}
      action={
        showRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>{title}</AlertTitle>
      {/* For a rejection that is not an `ApiError` the cause falls back to the
          title; printing the same sentence twice reads like a rendering bug. */}
      {cause !== title && <Typography variant="body2">{cause}</Typography>}
      {nextAction !== null && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {nextAction}
        </Typography>
      )}
      {requestId !== undefined && (
        <>
          <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
            {/* Verified end to end, not assumed: admin-server sets
                `genReqId: () => randomUUID()` in `create-base-server.ts`, logs
                it as `reqId` on every line for the request via the
                `scope-logger` hook, echoes it as the `X-Request-ID` response
                header, puts it in the error envelope this string comes from,
                and stores it on the audit row (`audit.repository.ts`) that the
                console's own Audit log renders. Same string in all five
                places. */}
            Request ID — quote this when reporting the problem. It appears in
            the admin server&apos;s logs and in this console&apos;s Audit log.
          </Typography>
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ alignItems: 'center', mt: 0.5 }}
          >
            <Typography
              variant="caption"
              component="code"
              sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
            >
              {requestId}
            </Typography>
            <CopyIconButton value={requestId} label="request ID" />
          </Stack>
        </>
      )}
    </Alert>
  );
};
