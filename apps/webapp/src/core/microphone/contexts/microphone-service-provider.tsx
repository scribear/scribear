import { microphoneService } from '../services/microphone-service';
import { MicrophoneServiceContext } from './microphone-service-context';

interface MicrophoneInterfaceProviderProps {
  children: React.ReactNode;
}

export const MicrophoneServiceProvider = ({
  children,
}: MicrophoneInterfaceProviderProps) => {
  return (
    <MicrophoneServiceContext value={{ microphoneService }}>
      {children}
    </MicrophoneServiceContext>
  );
};
