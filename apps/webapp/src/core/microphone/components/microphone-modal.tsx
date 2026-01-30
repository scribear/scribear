import { ChoiceModal } from '@/components/ui/choice-modal';
import { MicrophoneServiceStatus } from '@/core/microphone/services/microphone-service';
import {
  activateMicrophone,
  deactivateMicrophone,
} from '@/core/microphone/stores/microphone-preferences-slice';
import { selectMicrophoneServiceStatus } from '@/core/microphone/stores/microphone-service-slice';
import { useAppDispatch, useAppSelector } from '@/stores/use-redux';

export const MicrophoneModal = () => {
  const dispatch = useAppDispatch();
  const microphoneServiceStatus = useAppSelector(selectMicrophoneServiceStatus);

  const allowAccessMicrophone = () => {
    void dispatch(activateMicrophone());
  };

  const cancelModal = () => {
    void dispatch(deactivateMicrophone());
  };

  const infoPrompt = (
    <ChoiceModal
      isOpen={microphoneServiceStatus === MicrophoneServiceStatus.INFO_PROMPT}
      message="ScribeAR needs to access your microphone in order to provide live transcriptions and show visualizations."
      rightColor="success"
      rightAction="Allow"
      onRightAction={allowAccessMicrophone}
      onCancel={cancelModal}
    />
  );

  const deniedPrompt = (
    <ChoiceModal
      isOpen={microphoneServiceStatus === MicrophoneServiceStatus.DENIED_PROMPT}
      message="ScribeAR could not access your microphone because permission was denied. Please adjust your browser's configuration and try again."
      rightAction="Try Again"
      onRightAction={allowAccessMicrophone}
      onCancel={cancelModal}
    />
  );

  const errorPrompt = (
    <ChoiceModal
      isOpen={microphoneServiceStatus === MicrophoneServiceStatus.ERROR}
      message="Encountered unexpected error when accessing microphone."
      rightAction="Try Again"
      onRightAction={allowAccessMicrophone}
      onCancel={cancelModal}
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
