import React, { useEffect, useMemo, useState } from 'react';
import { Drawer, IconButton, Switch, FormControlLabel, Typography } from '@mui/material';
import TuneIcon from '@mui/icons-material/Tune';
import { Rnd } from 'react-rnd';

import { microphoneService } from '../../services/microphone-service';
import { loadVisualizerPrefs, saveVisualizerPrefs } from '../../stores/visualizer-preferences';
import { resolveRect } from '../../stores/resolve-visualizer-layout';
import { FrequencyVisualizer } from './visualizers/frequency-visualizer'; 

export function MicrophoneVisualizerOverlay() {
  const [openDrawer, setOpenDrawer] = useState(false);
  const [prefs, setPrefs] = useState(() => loadVisualizerPrefs());

  const [analyser, setAnalyser] = useState<AnalyserNode | null>(
    microphoneService.analyser
  );

  // subscribe to microphone service
  useEffect(() => {
    const onAnalyser = (a: AnalyserNode | null) => setAnalyser(a);
    microphoneService.on('analyserChange', onAnalyser);

    return () => {
      microphoneService.off('analyserChange', onAnalyser);
    };
  }, []);

  // persist prefs
  useEffect(() => {
    saveVisualizerPrefs(prefs);
  }, [prefs]);

  // resolve layout
  const resolved = useMemo(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    return {
      frequency: resolveRect(prefs.layout.frequency, vw, vh),
    };
  }, [prefs.layout]);

  // don't render if mic inactive
  if (!analyser) return null;

  return (
    <>
      {/* Gear button */}
      <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 5000 }}>
        <IconButton
          onClick={() => setOpenDrawer(true)}
          style={{
            background: 'white',
            border: '1px solid rgba(0,0,0,0.12)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}
        >
          <TuneIcon />
        </IconButton>
      </div>

      {/* Drawer */}
      <Drawer anchor="right" open={openDrawer} onClose={() => setOpenDrawer(false)}>
        <div style={{ width: 320, padding: 16 }}>
          <Typography variant="h6" gutterBottom>
            Microphone Visualizer
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={prefs.enabled.frequency}
                onChange={(e) =>
                  setPrefs((p) => ({
                    ...p,
                    enabled: { ...p.enabled, frequency: e.target.checked },
                  }))
                }
              />
            }
            label="Frequency"
          />
        </div>
      </Drawer>

      {/* Visualizer */}
      {prefs.enabled.frequency && (
        <VisualizerBlock
          rect={resolved.frequency}
          onRectChange={(r) =>
            setPrefs((p) => ({
              ...p,
              layout: { ...p.layout, frequency: r },
            }))
          }
        >
          <FrequencyVisualizer analyser={analyser} />
        </VisualizerBlock>
      )}
    </>
  );
}

function VisualizerBlock(props: {
  rect: { x: number; y: number; w: number; h: number };
  onRectChange: (r: { x: number; y: number; w: number; h: number }) => void;
  children: React.ReactNode;
}) {
  const { rect, onRectChange, children } = props;

  return (
    <Rnd
      size={{ width: rect.w, height: rect.h }}
      position={{ x: rect.x, y: rect.y }}
      onDragStop={(_, d) => onRectChange({ ...rect, x: d.x, y: d.y })}
      onResizeStop={(_, __, ref, ___, pos) =>
        onRectChange({
          x: pos.x,
          y: pos.y,
          w: ref.offsetWidth,
          h: ref.offsetHeight,
        })
      }
      bounds="window"
      minWidth={260} // slightly larger for spectrum readability
      minHeight={160}
      style={{
        zIndex: 4500,
        background: 'rgba(255,255,255,0.92)',
        border: '1px solid rgba(0,0,0,0.12)',
        borderRadius: 12,
        boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
        overflow: 'hidden',
      }}
    >
      <div style={{ height: '100%', width: '100%' }}>{children}</div>
    </Rnd>
  );
}