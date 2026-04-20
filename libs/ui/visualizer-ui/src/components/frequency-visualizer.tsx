import { useCallback, useRef } from 'react';

import Box from '@mui/material/Box';

import { useAnimationFrame } from '#src/hooks/use-animation-frame.js';

export interface FrequencyVisualizerProps {
  analyserNode: AnalyserNode | null;
  width: number;
  height: number;
  color: string;
}

const ML = 36; // left margin for Y labels
const MB = 18; // bottom margin for X labels
const MT = 6;
const MR = 18;

function makeByteArray(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

function fmtHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k`;
  return Math.round(hz).toString();
}

// Frequency tick positions in Hz shown on X-axis
const FREQ_TICKS_HZ = [100, 500, 1000, 2000, 5000, 10000, 20000];

export const FrequencyVisualizer = ({
  analyserNode,
  width,
  height,
  color,
}: FrequencyVisualizerProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const plotX = ML;
    const plotY = MT;
    const plotW = Math.max(1, width - ML - MR);
    const plotH = Math.max(1, height - MT - MB);

    ctx.font = '10px monospace';

    // Y-axis labels and grid lines (0%, 50%, 100%)
    const yTicks = [
      { label: '100%', frac: 0 },
      { label: '50%', frac: 0.5 },
      { label: '0%', frac: 1 },
    ];
    ctx.textAlign = 'right';
    for (const { label, frac } of yTicks) {
      const y = plotY + frac * plotH;
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(plotX, y);
      ctx.lineTo(plotX + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = color;
      ctx.fillText(label, plotX - 3, y + 3);
    }

    if (!analyserNode) {
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotX, plotY + plotH);
      ctx.lineTo(plotX + plotW, plotY + plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    const sampleRate = analyserNode.context.sampleRate;
    const nyquist = sampleRate / 2;
    const binCount = analyserNode.frequencyBinCount;

    if (dataRef.current?.length !== binCount) {
      dataRef.current = makeByteArray(binCount);
    }
    analyserNode.getByteFrequencyData(dataRef.current);

    const data = dataRef.current;
    const barCount = Math.min(binCount, Math.floor(plotW / 2));
    const barWidth = plotW / barCount;

    for (let i = 0; i < barCount; i++) {
      const binIndex = Math.floor((i / barCount) * binCount);
      const magnitude = (data[binIndex] ?? 0) / 255;
      const barHeight = magnitude * plotH;
      const hue = 200 - magnitude * 160;
      ctx.fillStyle = `hsl(${hue.toFixed(0)}, 85%, 48%)`;
      ctx.globalAlpha = 0.25 + magnitude * 0.75;
      ctx.fillRect(
        plotX + i * barWidth,
        plotY + plotH - barHeight,
        barWidth - 1,
        barHeight,
      );
    }
    ctx.globalAlpha = 1;

    // X-axis frequency labels
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    for (const hz of FREQ_TICKS_HZ) {
      if (hz > nyquist) break;
      const xFrac = hz / nyquist;
      const x = plotX + xFrac * plotW;
      if (x < plotX + 5 || x > plotX + plotW - 5) continue;
      // vertical tick
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plotY + plotH);
      ctx.lineTo(x, plotY + plotH + 3);
      ctx.stroke();
      // label
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = color;
      ctx.fillText(fmtHz(hz), x, height - 4);
    }
    ctx.globalAlpha = 1;
  }, [analyserNode, width, height, color]);

  useAnimationFrame(draw, true);

  return (
    <Box sx={{ bgcolor: 'action.selected', display: 'block', width, height }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ display: 'block', width, height }}
      />
    </Box>
  );
};
