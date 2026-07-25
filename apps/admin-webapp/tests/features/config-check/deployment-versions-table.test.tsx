import { screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect } from 'vitest';

import { DeploymentVersionsTable } from '#src/features/config-check/deployment-versions-table';
import type {
  ComposeFileStatus,
  DeploymentVersionsReport,
} from '#src/lib/admin-api';

import { renderWithProviders } from '../../utils/render-with-providers';

const COMMIT = 'def6e68f0b3c4a1d9e2f5a7b8c0d1e2f3a4b5c6d';

/** A healthy deployment: one commit everywhere, compose file in step. */
function report(
  overrides: Partial<DeploymentVersionsReport> = {},
): DeploymentVersionsReport {
  return {
    containers: [
      {
        service: 'admin-server',
        status: 'ok',
        build: {
          service: 'admin-server',
          version: '1.4.2',
          commit: COMMIT,
          ref: 'staging',
          builtAt: '2026-07-24T12:03:11Z',
          imageTags: ['staging'],
          pullRequest: null,
          origin: 'ci',
          dirty: false,
        },
      },
    ],
    composeFile: { expected: 3, reported: 3, status: 'match' },
    expectedCommit: COMMIT,
    mismatched: [],
    locallyBuilt: [],
    dirty: [],
    unstamped: false,
    checkedAt: '2026-07-25T09:00:00Z',
    ...overrides,
  };
}

function composeFile(
  status: ComposeFileStatus,
  reported: number | null,
): Partial<DeploymentVersionsReport> {
  return { composeFile: { expected: 3, reported, status } };
}

/** The compose file's own row, found by the label in its first cell. */
function composeRow(): HTMLElement {
  return screen.getByRole('row', { name: /compose\.yml/ });
}

describe('DeploymentVersionsTable compose file row', (it) => {
  it('has no a11y violations', async () => {
    const { container } = renderWithProviders(
      <DeploymentVersionsTable report={report()} loading={false} />,
    );

    const results = await axe(container);

    expect(results.violations).toHaveLength(0);
  });

  // The two findings that are not a match both render a banner, and a banner is
  // where the axe risk is: it is the only part of this component whose colour
  // changes with the status.
  it('has no a11y violations when the compose file is out of step', async () => {
    const { container } = renderWithProviders(
      <DeploymentVersionsTable
        report={report(composeFile('stale', 2))}
        loading={false}
      />,
    );

    const results = await axe(container);

    expect(results.violations).toHaveLength(0);
  });

  it('shows the reported version and the one the images expect', () => {
    // Act
    renderWithProviders(
      <DeploymentVersionsTable report={report()} loading={false} />,
    );

    // Assert — both halves of the comparison, so an operator can see which of
    // the two moved without reading the banner.
    const row = composeRow();
    expect(within(row).getByText('v3')).toBeInTheDocument();
    expect(within(row).getByText('expects v3')).toBeInTheDocument();
  });

  // Never colour alone: `stale` and `ahead` are the two an operator has to tell
  // apart to know whether to copy a file or pull images, and they share a
  // colour. The word in the chip is what distinguishes them.
  it('names each status in text, not only in colour', () => {
    // Arrange
    const cases: [ComposeFileStatus, number | null, string][] = [
      ['match', 3, 'in step'],
      ['stale', 2, 'old file'],
      ['ahead', 4, 'old images'],
      ['unknown', null, 'not reported'],
    ];

    for (const [status, reported, label] of cases) {
      // Act
      const { unmount } = renderWithProviders(
        <DeploymentVersionsTable
          report={report(composeFile(status, reported))}
          loading={false}
        />,
      );

      // Assert
      expect(within(composeRow()).getByText(label)).toBeInTheDocument();

      unmount();
    }
  });

  // A compose file older than the images is the failure this row exists for,
  // and the remedy is specific: copy the file, do not pull images again.
  it('tells the operator to copy the compose file when it is stale', () => {
    // Act
    renderWithProviders(
      <DeploymentVersionsTable
        report={report(composeFile('stale', 2))}
        loading={false}
      />,
    );

    // Assert
    expect(
      screen.getByText(/This stack is running an old compose file/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Copy the current deployment\/compose\.yml/),
    ).toBeInTheDocument();
  });

  // The mirror image, and deliberately not folded into "out of step": pulling
  // images is the fix here, and copying the file again would do nothing.
  it('tells the operator to pull images when the file is ahead', () => {
    // Act
    renderWithProviders(
      <DeploymentVersionsTable
        report={report(composeFile('ahead', 4))}
        loading={false}
      />,
    );

    // Assert
    expect(
      screen.getByText(/The compose file is newer than these images/),
    ).toBeInTheDocument();
  });

  // Absent is not a mismatch. It is reported as an absence of evidence, with an
  // em dash rather than a version, so nobody reads it as a measured value.
  it('reports an unversioned compose file without asserting a mismatch', () => {
    // Act
    renderWithProviders(
      <DeploymentVersionsTable
        report={report(composeFile('unknown', null))}
        loading={false}
      />,
    );

    // Assert
    expect(screen.getByText(/did not report a version/)).toBeInTheDocument();
    expect(within(composeRow()).getByText('not reported')).toBeInTheDocument();
  });

  // A match is carried by the row alone: a second green banner beside the
  // "every container is on one commit" one would halve the chance either is
  // read.
  it('raises no banner when the compose file matches', () => {
    // Act
    renderWithProviders(
      <DeploymentVersionsTable report={report()} loading={false} />,
    );

    // Assert
    expect(
      screen.queryByText(/The compose file matches these images/),
    ).not.toBeInTheDocument();
  });
});
