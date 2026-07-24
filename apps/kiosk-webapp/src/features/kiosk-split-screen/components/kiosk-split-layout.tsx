import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import { type DividerProps, Pane, SplitPane } from 'react-split-pane';

import { useDebouncedReduxValue } from '#src/hooks/use-debounced-redux-value';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import {
  DIVIDER_WIDTH_PX,
  LEFT_PANEL_MIN_WIDTH_PX,
  REFLOW_THRESHOLD_PX,
  RIGHT_PANEL_MIN_WIDTH_PX,
} from '../config/split-screen-config';
import {
  selectIsRightPanelOpen,
  selectTargetRightPanelWidthPercent,
  setTargetRightPanelWidthPercent,
  toggleRightPanelIsOpen,
} from '../stores/split-screen-preferences-slice';
import { SplitDivider } from './split-divider';

/**
 * Props for {@link KioskSplitLayout}.
 */
interface KioskSplitLayoutProps {
  left?: ReactNode;
  right?: ReactNode;
}

/**
 * Two-pane horizontal split layout for the kiosk view. The right pane width is
 * persisted via Redux and debounced on drag. The right panel can be collapsed
 * entirely using the `SplitDivider` toggle button.
 */
export const KioskSplitLayout = ({ left, right }: KioskSplitLayoutProps) => {
  const dispatch = useAppDispatch();
  const isRightPanelOpen = useAppSelector(selectIsRightPanelOpen);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  const [rightPanelWidthPercent, setRightWidthPercent] = useDebouncedReduxValue(
    selectTargetRightPanelWidthPercent,
    setTargetRightPanelWidthPercent,
    500,
  );

  const handleResize = (sizes: number[]) => {
    const containerWidth =
      containerRef.current?.getBoundingClientRect().width ?? 0;
    if (!containerWidth) return;
    if (sizes.length < 2 || !sizes[1]) return;

    setRightWidthPercent(sizes[1] / containerWidth);
  };

  const dividerWithToggle = useMemo(() => {
    return (props: DividerProps) => (
      <SplitDivider
        {...props}
        isOpen={isRightPanelOpen}
        onToggle={() => {
          dispatch(toggleRightPanelIsOpen());
        }}
      />
    );
  }, [isRightPanelOpen, dispatch]);

  const targetRightPanelWidthPx = Math.round(
    containerWidth * rightPanelWidthPercent,
  );

  // Clamp right panel width so that max width of left and right panels are respected
  const rightPanelWidthPx = Math.min(
    Math.max(containerWidth - LEFT_PANEL_MIN_WIDTH_PX, 0),
    Math.max(targetRightPanelWidthPx, RIGHT_PANEL_MIN_WIDTH_PX),
  );

  // Reflow to a single vertical column when too narrow for two side-by-side
  // panes (SC 1.4.10). Keep the same ref element in both branches so the
  // ResizeObserver keeps measuring across the switch.
  const isNarrow = containerWidth > 0 && containerWidth < REFLOW_THRESHOLD_PX;

  return (
    <Box ref={containerRef} sx={{ height: '100%', width: '100%' }}>
      {isNarrow ? (
        <Box
          sx={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{left}</Box>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              backgroundColor: 'primary.main',
              flexShrink: 0,
            }}
          >
            <Tooltip
              title={isRightPanelOpen ? 'Collapse panel' : 'Expand panel'}
            >
              <IconButton
                aria-label={
                  isRightPanelOpen ? 'Collapse panel' : 'Expand panel'
                }
                aria-expanded={isRightPanelOpen}
                onClick={() => {
                  dispatch(toggleRightPanelIsOpen());
                }}
                sx={{ color: 'primary.contrastText', p: 0.5 }}
              >
                {isRightPanelOpen ? (
                  <ExpandLessIcon fontSize="small" />
                ) : (
                  <ExpandMoreIcon fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
          </Box>
          {isRightPanelOpen && (
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{right}</Box>
          )}
        </Box>
      ) : (
        <SplitPane
          direction="horizontal"
          divider={dividerWithToggle}
          dividerSize={DIVIDER_WIDTH_PX}
          onResize={handleResize}
          style={{ height: '100%' }}
        >
          <Pane minSize={`${LEFT_PANEL_MIN_WIDTH_PX.toString()}px`}>
            {left}
          </Pane>
          {isRightPanelOpen ? (
            <Pane
              size={`${rightPanelWidthPx.toString()}px`}
              minSize={`${RIGHT_PANEL_MIN_WIDTH_PX.toString()}px`}
            >
              {right}
            </Pane>
          ) : (
            <Pane size={0} maxSize={0}>
              <div></div>
            </Pane>
          )}
        </SplitPane>
      )}
    </Box>
  );
};
