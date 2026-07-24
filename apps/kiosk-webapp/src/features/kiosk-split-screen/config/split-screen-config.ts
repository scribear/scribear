// Minimum pixel width of the left (transcription) pane in the split layout.
export const LEFT_PANEL_MIN_WIDTH_PX = 100;
// Minimum pixel width of the right (kiosk status) pane in the split layout.
export const RIGHT_PANEL_MIN_WIDTH_PX = 200;

// Pixel width of the draggable divider bar between the two panes.
export const DIVIDER_WIDTH_PX = 12;

// Below this container width the two panes can't fit side by side without
// horizontal scrolling (min widths sum to ~312px), so the layout reflows to a
// single vertical column instead. Keeps SC 1.4.10 (Reflow) at 320px. */
export const REFLOW_THRESHOLD_PX = 480;
