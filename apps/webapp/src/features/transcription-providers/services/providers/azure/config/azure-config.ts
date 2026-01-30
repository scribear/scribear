import { AzureStatus } from '../types/azure-status';

export interface AzureConfig {
  regionId: string;
  apiKey: string;
}

export const DEFAULT_AZURE_CONFIG = {
  regionId: '',
  apiKey: '',
};

export const AZURE_DISPLAY_NAME = 'Microsoft Azure';

export const INITIAL_AZURE_STATUS = AzureStatus.INACTIVE;
