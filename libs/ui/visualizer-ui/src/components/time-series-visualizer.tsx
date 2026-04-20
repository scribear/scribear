import { useCallback, useRef } from 'react';

import Box from '@mui/material/Box';

import { useAnimationFrame } from '#src/hooks/use-animation-frame.js';

export interface TimeSeriesVisualizerProps {
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

function fmtMs(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

export const TimeSeriesVisualizer = ({
  analyserNode,
  width,
  height,
  color,
}: TimeSeriesVisualizerProps) => {
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
    const midY = plotY + plotH / 2;

    ctx.font = '10px monospace';

    // Y-axis labels: +1, 0, -1
    const yTicks = [
      { label: '+1', frac: 0 },
      { label: '0', frac: 0.5 },
      { label: '-1', frac: 1 },
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
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(plotX, midY);
      ctx.lineTo(plotX + plotW, midY);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    const sampleRate = analyserNode.context.sampleRate;
    const bufferLength = analyserNode.fftSize;
    const totalMs = (bufferLength / sampleRate) * 1000;

    if (dataRef.current?.length !== bufferLength) {
      dataRef.current = makeByteArray(bufferLength);
    }
    analyserNode.getByteTimeDomainData(dataRef.current);

    const data = dataRef.current;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();

    const sliceW = plotW / bufferLength;
    for (let i = 0; i < bufferLength; i++) {
      const v = (data[i] ?? 128) / 128 - 1;
      const x = plotX + i * sliceW;
      const y = midY - v * (plotH / 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // X-axis time labels — pick ~4 evenly spaced ticks
    const tickCount = 4;
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    for (let t = 0; t <= tickCount; t++) {
      const frac = t / tickCount;
      const x = plotX + frac * plotW;
      const ms = frac * totalMs;
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plotY + plotH);
      ctx.lineTo(x, plotY + plotH + 3);
      ctx.stroke();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = color;
      ctx.fillText(fmtMs(ms), x, height - 4);
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
