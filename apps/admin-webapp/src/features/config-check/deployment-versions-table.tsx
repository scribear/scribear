import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import HelpOutlinedIcon from '@mui/icons-material/HelpOutlined';
import RemoveCircleOutlinedIcon from '@mui/icons-material/RemoveCircleOutlined';
import WarningIcon from '@mui/icons-material/Warning';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import type {
  ComposeFileStatus,
  ComposeFileVersion,
  ContainerVersion,
  DeploymentVersionsReport,
  VersionProbeStatus,
} from '#src/lib/admin-api';

/**
 * The literal every reporter substitutes for a field its build did not supply.
 * Never rendered as-is: a cell that says "unknown" twice tells an operator less
 * than an em dash and one explanation at the top of the table.
 */
const UNKNOWN = 'unknown';

const SHORT_COMMIT_LENGTH = 7;

const STATUS_META: Record<
  VersionProbeStatus,
  { label: string; color: 'success' | 'warning' | 'error' | 'default' }
> = {
  ok: { label: 'reporting', color: 'success' },
  unsupported: { label: 'old image', color: 'warning' },
  unreachable: { label: 'no answer', color: 'error' },
  'not-reported': { label: 'n/a', color: 'default' },
};

/**
 * The compose file's four outcomes, as a row and as a banner.
 *
 * Every one of them is an icon *and* a word: colour alone would leave `stale`
 * and `ahead` — the two an operator has to tell apart to know whether to copy a
 * file or pull images — indistinguishable to anyone reading this in greyscale
 * or with a colour vision deficiency.
 */
const COMPOSE_STATUS_META: Record<
  ComposeFileStatus,
  {
    label: string;
    color: 'success' | 'warning' | 'default';
    severity: 'success' | 'warning' | 'info';
    icon: React.ReactElement;
    /** Headline of the banner. States the finding, not the status name. */
    title: string;
    /** What it means and what to do about it. */
    detail: string;
  }
> = {
  match: {
    label: 'in step',
    color: 'success',
    severity: 'success',
    icon: <CheckCircleIcon fontSize="small" />,
    title: 'The compose file matches these images',
    detail:
      'deployment/compose.yml is the version these images were built for.',
  },
  stale: {
    label: 'old file',
    color: 'warning',
    severity: 'warning',
    icon: <WarningIcon fontSize="small" />,
    title: 'This stack is running an old compose file',
    detail:
      'The images were pulled but deployment/compose.yml was not updated, so services, environment variables or wiring these images expect may simply be absent. Copy the current deployment/compose.yml from the repo and run `docker compose up -d`.',
  },
  ahead: {
    label: 'old images',
    color: 'warning',
    severity: 'warning',
    icon: <WarningIcon fontSize="small" />,
    title: 'The compose file is newer than these images',
    detail:
      'deployment/compose.yml was updated but the images were not all pulled, so this stack is half upgraded. Run `docker compose pull && docker compose up -d` in deployment/.',
  },
  unknown: {
    label: 'not reported',
    color: 'default',
    severity: 'info',
    icon: <HelpOutlinedIcon fontSize="small" />,
    title: 'The compose file did not report a version',
    detail:
      'It predates this check, so it is at least that old — which is not the same as being wrong, only unverifiable. Copy the current deployment/compose.yml from the repo and run `docker compose up -d` to start reporting it.',
  },
};

function shortCommit(commit: string): string {
  return commit === UNKNOWN ? '—' : commit.slice(0, SHORT_COMMIT_LENGTH);
}

function formatBuiltAt(builtAt: string): string {
  if (builtAt === UNKNOWN) return '—';
  const parsed = new Date(builtAt);
  return Number.isNaN(parsed.getTime())
    ? builtAt
    : parsed.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

/**
 * One container's row.
 *
 * The commit is the column that matters and is therefore the one that carries
 * the mismatch marker: an operator scanning this table is looking for the row
 * that does not match the others, and asking them to compare eight
 * seven-character hashes by eye is how a stale container gets missed.
 */
const ContainerRow = ({
  container,
  isMismatched,
}: {
  container: ContainerVersion;
  isMismatched: boolean;
}) => {
  const { build, status } = container;
  const meta = STATUS_META[status];

  return (
    <TableRow hover>
      <TableCell sx={{ fontWeight: 500 }}>{container.service}</TableCell>
      <TableCell>
        {build?.version === UNKNOWN ? '—' : (build?.version ?? '—')}
      </TableCell>
      <TableCell>
        {build === null ? (
          '—'
        ) : (
          <Stack
            direction="row"
            spacing={0.75}
            sx={{
              alignItems: 'center',
            }}
          >
            <Box component="code" sx={{ fontFamily: 'monospace' }}>
              {shortCommit(build.commit)}
            </Box>
            {isMismatched && (
              <Tooltip title="This container is not on the commit the rest of the stack reports. It was almost certainly missed by the last upgrade.">
                <WarningIcon color="warning" fontSize="small" />
              </Tooltip>
            )}
            {build.dirty && (
              <Tooltip title="Built from a working tree with uncommitted changes, so this commit does not describe what is running.">
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label="dirty"
                />
              </Tooltip>
            )}
          </Stack>
        )}
      </TableCell>
      <TableCell>
        {build?.ref === UNKNOWN ? '—' : (build?.ref ?? '—')}
      </TableCell>
      <TableCell>
        {build === null ? '—' : formatBuiltAt(build.builtAt)}
      </TableCell>
      <TableCell>
        {build === null || build.imageTags.length === 0 ? (
          '—'
        ) : (
          <Stack
            direction="row"
            spacing={0.5}
            useFlexGap
            sx={{
              flexWrap: 'wrap',
            }}
          >
            {build.imageTags.map((tag) => (
              <Chip key={tag} size="small" variant="outlined" label={tag} />
            ))}
          </Stack>
        )}
      </TableCell>
      <TableCell>
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Chip
            size="small"
            color={meta.color}
            variant="outlined"
            label={meta.label}
          />
          {build?.pullRequest !== null && build?.pullRequest !== undefined && (
            <Chip
              size="small"
              color="info"
              variant="outlined"
              label={`PR #${String(build.pullRequest)}`}
            />
          )}
          {build?.origin === 'local' && (
            <Tooltip title="Built by build-containers.sh on someone's machine, not published by CI. Two deployments reporting this commit are not necessarily running the same bytes.">
              <Chip size="small" variant="outlined" label="local build" />
            </Tooltip>
          )}
          {container.detail !== undefined && (
            <Tooltip title={container.detail}>
              <HelpOutlinedIcon fontSize="small" color="disabled" />
            </Tooltip>
          )}
        </Stack>
      </TableCell>
    </TableRow>
  );
};

/**
 * The compose file, as a row in the same table.
 *
 * It is not a container and does not pretend to be one — it has no commit,
 * branch or build time, and says so with the same em dash a container that did
 * not supply a field uses. It belongs here anyway: an operator reading this
 * table is asking "is this deployment consistent?", and the file wiring the
 * containers together is the one piece of it that no image carries and no
 * `docker compose pull` updates.
 */
const ComposeFileRow = ({
  composeFile,
}: {
  composeFile: ComposeFileVersion;
}) => {
  const meta = COMPOSE_STATUS_META[composeFile.status];

  return (
    <TableRow hover>
      <TableCell sx={{ fontWeight: 500 }}>compose.yml</TableCell>
      <TableCell>
        {composeFile.reported === null
          ? '—'
          : `v${String(composeFile.reported)}`}
      </TableCell>
      <TableCell>—</TableCell>
      <TableCell>—</TableCell>
      <TableCell>—</TableCell>
      <TableCell>
        <Tooltip
          title={`These images were built for compose file v${String(composeFile.expected)}.`}
        >
          <Chip
            size="small"
            variant="outlined"
            label={`expects v${String(composeFile.expected)}`}
          />
        </Tooltip>
      </TableCell>
      <TableCell>
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Chip
            size="small"
            color={meta.color}
            variant="outlined"
            icon={meta.icon}
            label={meta.label}
          />
          <Tooltip title={meta.detail}>
            <HelpOutlinedIcon fontSize="small" color="disabled" />
          </Tooltip>
        </Stack>
      </TableCell>
    </TableRow>
  );
};

/**
 * What each container in this deployment was built from.
 *
 * This is the only place in the console that can answer the question, and the
 * reason is worth stating: every service knows its own build and no service
 * knows anyone else's, so a half-finished upgrade — one image pulled, another
 * not — is invisible from inside any single container. The health rollup shows
 * every component green throughout, because a stale container is a perfectly
 * healthy container.
 */
export const DeploymentVersionsTable = ({
  report,
  loading,
}: {
  report: DeploymentVersionsReport | null;
  loading: boolean;
}) => {
  if (loading && report === null) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (report === null) {
    return (
      <Alert severity="warning">
        The per-container versions could not be read. The findings above are
        unaffected — they come from a separate check.
      </Alert>
    );
  }

  const mismatched = new Set(report.mismatched);
  const stale = report.containers.filter((c) => c.status === 'unsupported');
  const composeMeta = COMPOSE_STATUS_META[report.composeFile.status];

  return (
    <Box>
      {/* The answer, before the table that supports it. An operator opening
          this page has one question, and eleven rows of hashes is not it. */}
      {report.unstamped ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>Nothing here was built by CI</AlertTitle>
          Containers answered, and none of them knows what it was built from —
          the signature of a stack running local code (<code>npm run dev</code>,
          or images built by hand). Build with{' '}
          <code>./build-containers.sh</code> to stamp the commit in.
        </Alert>
      ) : mismatched.size > 0 ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>
            {mismatched.size} container{mismatched.size === 1 ? '' : 's'} not on{' '}
            {report.expectedCommit === null
              ? 'the deployed commit'
              : report.expectedCommit.slice(0, SHORT_COMMIT_LENGTH)}
          </AlertTitle>
          {report.mismatched.join(', ')} —{' '}
          {mismatched.size === 1 ? 'it is' : 'they are'} running a different
          build from the rest of the stack, which is what an upgrade that only
          partly completed looks like. Run <code>docker compose up -d</code> in{' '}
          <code>deployment/</code> and re-check.
        </Alert>
      ) : (
        <Alert severity="success" icon={<CheckCircleIcon />} sx={{ mb: 2 }}>
          <AlertTitle>Every reporting container is on one commit</AlertTitle>
          {report.expectedCommit === null
            ? 'No commit was reported.'
            : `This deployment is running ${report.expectedCommit.slice(0, SHORT_COMMIT_LENGTH)}.`}
        </Alert>
      )}
      {stale.length > 0 && (
        <Alert severity="warning" icon={<ErrorIcon />} sx={{ mb: 2 }}>
          <AlertTitle>
            {stale.length} container{stale.length === 1 ? '' : 's'} predate
            {stale.length === 1 ? 's' : ''} build reporting
          </AlertTitle>
          {stale.map((c) => c.service).join(', ')} answered but has no build
          document at all, so its image is older than this admin-server and was
          not recreated by the last upgrade.
        </Alert>
      )}
      {/* Only when there is something to say. A green "the compose file
          matches" banner on top of the green commit banner would double the
          reassurance and halve the chance either is read; the row in the table
          below carries the match case. */}
      {report.composeFile.status !== 'match' && (
        <Alert
          severity={composeMeta.severity}
          icon={composeMeta.icon}
          sx={{ mb: 2 }}
        >
          <AlertTitle>{composeMeta.title}</AlertTitle>
          {composeMeta.detail}
        </Alert>
      )}
      {report.locallyBuilt.length > 0 && !report.unstamped && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>Locally built images are running here</AlertTitle>
          {report.locallyBuilt.join(', ')} came from{' '}
          <code>build-containers.sh</code> rather than from a published CI
          build, so the commit identifies the source but not the artifact.
          {report.dirty.length > 0 && (
            <>
              {' '}
              {report.dirty.join(', ')}{' '}
              {report.dirty.length === 1 ? 'was' : 'were'} built from a working
              tree with uncommitted changes, so even the commit does not
              describe what is running.
            </>
          )}
        </Alert>
      )}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Container</TableCell>
              <TableCell>Version</TableCell>
              <TableCell>Commit</TableCell>
              <TableCell>Branch</TableCell>
              <TableCell>Built</TableCell>
              <TableCell>Image tags</TableCell>
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {report.containers.map((container) => (
              <ContainerRow
                key={container.service}
                container={container}
                isMismatched={mismatched.has(container.service)}
              />
            ))}
            {/* Last, below every container: it is part of the deployment but
                not part of the fleet of images above it. */}
            <ComposeFileRow composeFile={report.composeFile} />
          </TableBody>
        </Table>
      </TableContainer>
      <Typography
        variant="caption"
        sx={{
          color: 'text.secondary',
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          mt: 1,
        }}
      >
        <RemoveCircleOutlinedIcon fontSize="inherit" />
        Every container value is baked into the image at build time, so it
        describes the artifact rather than the source tree it sits next to. An
        em dash means the build did not supply that field. The{' '}
        <code>compose.yml</code> row is the exception: it is not an image, and
        its version is the literal the running compose file passes to
        admin-server. Read {new Date(report.checkedAt).toLocaleString()}.
      </Typography>
    </Box>
  );
};
