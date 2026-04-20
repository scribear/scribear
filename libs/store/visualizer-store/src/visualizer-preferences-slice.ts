import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import {
  VISUALIZER_CONFIG,
  VISUALIZER_DEFAULTS,
} from './config/visualizer-config.js';

export interface EnabledVisualizers {
  frequency: boolean;
  timeSeries: boolean;
  melCepstrum: boolean;
}

export interface VisualizerPreferencesSlice {
  enabledVisualizers: EnabledVisualizers;
  targetX: number;
  targetY: number;
  targetWidth: number;
  targetHeight: number;
}

interface WithVisualizerPreferences {
  visualizerPreferences: VisualizerPreferencesSlice;
}

const initialState: VisualizerPreferencesSlice = {
  enabledVisualizers: {
    frequency: true,
    timeSeries: true,
    melCepstrum: true,
  },
  targetX: VISUALIZER_DEFAULTS.targetX,
  targetY: VISUALIZER_DEFAULTS.targetY,
  targetWidth: VISUALIZER_DEFAULTS.targetWidth,
  targetHeight: VISUALIZER_DEFAULTS.targetHeight,
};

export const selectEnabledVisualizers = (state: WithVisualizerPreferences) =>
  state.visualizerPreferences.enabledVisualizers;

export const selectVisualizerTargetX = (state: WithVisualizerPreferences) =>
  state.visualizerPreferences.targetX;

export const selectVisualizerTargetY = (state: WithVisualizerPreferences) =>
  state.visualizerPreferences.targetY;

export const selectVisualizerTargetWidth = (state: WithVisualizerPreferences) =>
  state.visualizerPreferences.targetWidth;

export const selectVisualizerTargetHeight = (
  state: WithVisualizerPreferences,
) => state.visualizerPreferences.targetHeight;

export const visualizerPreferencesSlice = createSlice({
  name: 'visualizerPreferences',
  initialState,
  reducers: {
    setFrequencyEnabled: (state, action: PayloadAction<boolean>) => {
      state.enabledVisualizers.frequency = action.payload;
    },
    setTimeSeriesEnabled: (state, action: PayloadAction<boolean>) => {
      state.enabledVisualizers.timeSeries = action.payload;
    },
    setMelCepstrumEnabled: (state, action: PayloadAction<boolean>) => {
      state.enabledVisualizers.melCepstrum = action.payload;
    },
    setVisualizerPosition: (
      state,
      action: PayloadAction<{ x: number; y: number }>,
    ) => {
      state.targetX = Math.max(
        VISUALIZER_CONFIG.position.min,
        action.payload.x,
      );
      state.targetY = Math.max(
        VISUALIZER_CONFIG.position.min,
        action.payload.y,
      );
    },
    setVisualizerSize: (
      state,
      action: PayloadAction<{ width: number; height: number }>,
    ) => {
      state.targetWidth = Math.max(
        VISUALIZER_CONFIG.width.min,
        action.payload.width,
      );
      state.targetHeight = Math.max(
        VISUALIZER_CONFIG.height.min,
        action.payload.height,
      );
    },
    resetVisualizerPreferences: (state) => {
      state.enabledVisualizers = initialState.enabledVisualizers;
      state.targetX = initialState.targetX;
      state.targetY = initialState.targetY;
      state.targetWidth = initialState.targetWidth;
      state.targetHeight = initialState.targetHeight;
    },
  },
});

export const visualizerPreferencesReducer = visualizerPreferencesSlice.reducer;

export const {
  setFrequencyEnabled,
  setTimeSeriesEnabled,
  setMelCepstrumEnabled,
  setVisualizerPosition,
  setVisualizerSize,
  resetVisualizerPreferences,
} = visualizerPreferencesSlice.actions;
