import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import Box from '@mui/material/Box';

import { type DividerProps, Pane, SplitPane } from 'react-split-pane';

import { useDebouncedReduxValue } from '#src/hooks/use-debounced-redux-value';
import { useAppDispatch, useAppSelector } from '#src/stores/use-redux';

import {
  DIVIDER_WIDTH_PX,
  LEFT_PANEL_MIN_WIDTH_PX,
  RIGHT_PANEL_MIN_WIDTH_PX,
} from '../config/split-screen-config';
import {
  selectIsRightPanelOpen,
  selectTargetRightPanelWidthPercent,
  setTargetRightPanelWidthPercent,
  toggleRightPanelIsOpen,
} from '../stores/split-screen-preferences-slice';
import { SplitDivider } from './split-divider';

interface KioskSplitLayoutProps {
  left?: ReactNode;
  right?: ReactNode;
}

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

  return (
    <Box ref={containerRef} sx={{ height: '100%', width: '100%' }}>
      <SplitPane
        direction="horizontal"
        divider={dividerWithToggle}
        dividerSize={DIVIDER_WIDTH_PX}
        onResize={handleResize}
        style={{ height: '100%' }}
      >
        <Pane minSize={`${LEFT_PANEL_MIN_WIDTH_PX.toString()}px`}>{left}</Pane>
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
    </Box>
  );
};
