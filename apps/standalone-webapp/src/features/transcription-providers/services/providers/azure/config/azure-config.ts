import { AzureStatus } from '../types/azure-status';

/**
 * Configuration required to connect to the Microsoft Azure Speech-to-Text service.
 */
export interface AzureConfig {
  /**
   * Azure region identifier (e.g. `"eastus"`).
   */
  regionId: string;
  /**
   * Azure Cognitive Services subscription key.
   */
  apiKey: string;
}

// Default (empty) Azure configuration used before the user enters credentials.
export const DEFAULT_AZURE_CONFIG = {
  regionId: '',
  apiKey: '',
};

// Human-readable name shown in the UI for the Azure provider.
export const AZURE_DISPLAY_NAME = 'Microsoft Azure';

// The status that `AzureProvider` is initialized with before any connection attempt.
export const INITIAL_AZURE_STATUS = AzureStatus.INACTIVE;
