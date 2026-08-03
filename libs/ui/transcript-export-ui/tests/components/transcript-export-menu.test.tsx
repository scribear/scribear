import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TranscriptExportMenu } from '#src/components/transcript-export-menu.js';

import { axeViolations } from '../a11y.js';
import { renderWithProviders } from '../render.js';

type Props = Parameters<typeof TranscriptExportMenu>[0];

function renderMenu(overrides: Partial<Props> = {}) {
  const props: Props = {
    transcriptWordCount: 1200,
    isSummarizationOffered: true,
    needsModelDownload: false,
    hasCompletedRun: false,
    isSummarizing: false,
    progress: null,
    downloadProgress: null,
    hasSavedSummary: false,
    errorMessage: null,
    onDownloadTranscript: vi.fn(),
    onRequestSummary: vi.fn(),
    onDownloadLastSummary: vi.fn(),
    onCancelSummary: vi.fn(),
    onDismissError: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<TranscriptExportMenu {...props} />);
  return props;
}

/**
 * Expands the drawer group so its controls are reachable.
 *
 * The group's toggle is the icon button, not the heading text - a click on the
 * heading leaves the content collapsed, where `getByRole` cannot see it.
 */
async function openGroup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole('button', { name: 'Expand Save Transcript' }),
  );
}

describe('TranscriptExportMenu', () => {
  describe('downloading the transcript', () => {
    it('offers the download', async () => {
      const user = userEvent.setup();
      const props = renderMenu();
      await openGroup(user);

      await user.click(
        screen.getByRole('button', { name: /download transcript/i }),
      );

      expect(props.onDownloadTranscript).toHaveBeenCalledOnce();
    });

    it('does not ask for confirmation - saving a transcript costs nothing', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openGroup(user);

      await user.click(
        screen.getByRole('button', { name: /download transcript/i }),
      );

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('says how much there is to save', async () => {
      const user = userEvent.setup();
      renderMenu({ transcriptWordCount: 9412 });
      await openGroup(user);

      expect(screen.getByText(/9,412 words so far/)).toBeInTheDocument();
    });

    it('disables the download and says why when nothing has been said', async () => {
      const user = userEvent.setup();
      renderMenu({ transcriptWordCount: 0 });
      await openGroup(user);

      expect(
        screen.getByRole('button', { name: /download transcript/i }),
      ).toBeDisabled();
      expect(
        screen.getByText(/nothing has been transcribed yet/i),
      ).toBeInTheDocument();
    });
  });

  describe('when the browser cannot summarize', () => {
    it('omits every summary control', async () => {
      // Absent, not disabled: a device below the model's hardware bar offers
      // the user no path forward, so there is nothing to grey out.
      const user = userEvent.setup();
      renderMenu({ isSummarizationOffered: false });
      await openGroup(user);

      expect(
        screen.queryByRole('button', { name: /download summary/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/generated locally/i)).not.toBeInTheDocument();
    });

    it('still offers the transcript download', async () => {
      const user = userEvent.setup();
      renderMenu({ isSummarizationOffered: false });
      await openGroup(user);

      expect(
        screen.getByRole('button', { name: /download transcript/i }),
      ).toBeEnabled();
    });
  });

  describe('summary gating', () => {
    it('says on the menu itself that summaries are made locally', async () => {
      // Visible without opening the dialog, for the user who never opens it.
      const user = userEvent.setup();
      renderMenu();
      await openGroup(user);

      expect(
        screen.getByText(
          /Summaries are generated locally, by your browser, on this device\. Nothing is uploaded\./,
        ),
      ).toBeInTheDocument();
    });

    it('does not start a summary until the user confirms', async () => {
      const user = userEvent.setup();
      const props = renderMenu();
      await openGroup(user);

      await user.click(
        screen.getByRole('button', { name: /download summary/i }),
      );

      expect(props.onRequestSummary).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Summarize' }));
      expect(props.onRequestSummary).toHaveBeenCalledOnce();
    });

    it('repeats the local-only guarantee in the dialog', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openGroup(user);
      await user.click(
        screen.getByRole('button', { name: /download summary/i }),
      );

      expect(screen.getByRole('dialog')).toHaveTextContent(
        /generated locally, by your browser/i,
      );
      expect(screen.getByRole('dialog')).toHaveTextContent(
        /nothing is uploaded/i,
      );
    });

    it('warns about the 1.8 GB model download before spending it', async () => {
      const user = userEvent.setup();
      const props = renderMenu({ needsModelDownload: true });
      await openGroup(user);

      await user.click(
        screen.getByRole('button', { name: /download summary/i }),
      );

      expect(screen.getByRole('dialog')).toHaveTextContent(/1\.8 GB/);
      expect(screen.getByRole('dialog')).toHaveTextContent(/one-time/i);
      expect(
        screen.getByRole('button', { name: /download model and summarize/i }),
      ).toBeInTheDocument();
      expect(props.onRequestSummary).not.toHaveBeenCalled();
    });

    it('warns that the first run is slow when it has never been run', async () => {
      const user = userEvent.setup();
      renderMenu({ needsModelDownload: false, hasCompletedRun: false });
      await openGroup(user);
      await user.click(
        screen.getByRole('button', { name: /download summary/i }),
      );

      expect(screen.getByRole('dialog')).toHaveTextContent(/first summary/i);
    });

    it('warns that a long transcript takes several minutes', async () => {
      const user = userEvent.setup();
      renderMenu({ transcriptWordCount: 9412 });
      await openGroup(user);
      await user.click(
        screen.getByRole('button', { name: /download summary/i }),
      );

      expect(screen.getByRole('dialog')).toHaveTextContent(
        /9,412 words.*sections.*several minutes/is,
      );
    });

    it('says the output is machine-generated', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openGroup(user);
      await user.click(
        screen.getByRole('button', { name: /download summary/i }),
      );

      expect(screen.getByRole('dialog')).toHaveTextContent(
        /machine-generated/i,
      );
    });

    it('starts nothing when the confirmation is cancelled', async () => {
      const user = userEvent.setup();
      const props = renderMenu();
      await openGroup(user);
      await user.click(
        screen.getByRole('button', { name: /download summary/i }),
      );

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(props.onRequestSummary).not.toHaveBeenCalled();
    });
  });

  describe('while a summary is running', () => {
    it('reports which section it is on, not a blank wait', async () => {
      const user = userEvent.setup();
      renderMenu({
        isSummarizing: true,
        progress: { pass: 1, completedSections: 2, totalSections: 7 },
      });
      await openGroup(user);

      expect(screen.getByRole('status')).toHaveTextContent(
        /Summarizing section 3 of 7/,
      );
    });

    it('says when it has moved on to combining the summaries', async () => {
      const user = userEvent.setup();
      renderMenu({
        isSummarizing: true,
        progress: { pass: 2, completedSections: 0, totalSections: 2 },
      });
      await openGroup(user);

      expect(screen.getByRole('status')).toHaveTextContent(
        /Combining summaries \(pass 2\), section 1 of 2/,
      );
    });

    it('reports the model download separately from summarizing', async () => {
      const user = userEvent.setup();
      renderMenu({ isSummarizing: true, downloadProgress: 0.42 });
      await openGroup(user);

      expect(screen.getByRole('status')).toHaveTextContent(
        /Downloading your browser's built-in AI model/,
      );
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '42',
      );
    });

    it('can be cancelled', async () => {
      const user = userEvent.setup();
      const props = renderMenu({
        isSummarizing: true,
        progress: { pass: 1, completedSections: 0, totalSections: 4 },
      });
      await openGroup(user);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(props.onCancelSummary).toHaveBeenCalledOnce();
    });

    it('does not offer a second run while one is going', async () => {
      const user = userEvent.setup();
      renderMenu({ isSummarizing: true });
      await openGroup(user);

      expect(
        screen.getByRole('button', { name: /download summary/i }),
      ).toBeDisabled();
    });
  });

  describe('after a summary has been produced', () => {
    it('offers to save it again', async () => {
      const user = userEvent.setup();
      const props = renderMenu({ hasSavedSummary: true });
      await openGroup(user);

      await user.click(
        screen.getByRole('button', { name: /save the last summary again/i }),
      );

      expect(props.onDownloadLastSummary).toHaveBeenCalledOnce();
    });
  });

  describe('errors', () => {
    it('shows the failure and lets the user dismiss it', async () => {
      const user = userEvent.setup();
      const props = renderMenu({
        errorMessage: 'This device cannot run your browser’s summarizer.',
      });
      await openGroup(user);

      expect(screen.getByRole('alert')).toHaveTextContent(/cannot run/i);
      await user.click(screen.getByRole('button', { name: /close/i }));
      expect(props.onDismissError).toHaveBeenCalledOnce();
    });
  });

  it('has no automatically detectable accessibility violations', async () => {
    const user = userEvent.setup();
    renderMenu({
      isSummarizing: true,
      progress: { pass: 1, completedSections: 1, totalSections: 3 },
    });
    await openGroup(user);

    expect(await axeViolations()).toEqual([]);
  });
});
