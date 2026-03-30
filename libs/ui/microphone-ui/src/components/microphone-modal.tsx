import { ChoiceModal } from '@scribear/core-ui';
import { MicrophoneServiceStatus } from '@scribear/microphone-store';

/**
 * Props for {@link MicrophoneModal}.
 */
interface MicrophoneModalProps {
  // The current status of the microphone service, used to determine which modal to display.
  microphoneServiceStatus: MicrophoneServiceStatus;
  // Called when the user confirms they want to grant microphone access or retry after a failure.
  activate: () => void;
  // Called when the user dismisses or cancels the microphone prompt.
  deactivate: () => void;
}

/**
 * Renders microphone permission prompts based on the current service status.
 */
export const MicrophoneModal = ({
  microphoneServiceStatus,
  activate,
  deactivate,
}: MicrophoneModalProps) => {
  const infoPrompt = (
    <ChoiceModal
      isOpen={microphoneServiceStatus === MicrophoneServiceStatus.INFO_PROMPT}
      message="ScribeAR needs to access your microphone in order to provide live transcriptions and show visualizations."
      rightColor="success"
      rightAction="Allow"
      onRightAction={activate}
      onCancel={deactivate}
    />
  );

  const deniedPrompt = (
    <ChoiceModal
      isOpen={microphoneServiceStatus === MicrophoneServiceStatus.DENIED_PROMPT}
      message="ScribeAR could not access your microphone because permission was denied. Please adjust your browser's configuration and try again."
      rightAction="Try Again"
      onRightAction={activate}
      onCancel={deactivate}
    />
  );

  const errorPrompt = (
    <ChoiceModal
      isOpen={microphoneServiceStatus === MicrophoneServiceStatus.ERROR}
      message="Encountered an unexpected error when accessing microphone."
      rightAction="Try Again"
      onRightAction={activate}
      onCancel={deactivate}
    />
  );

  return (
    <>
      {infoPrompt}
      {deniedPrompt}
      {errorPrompt}
    </>
  );
};
