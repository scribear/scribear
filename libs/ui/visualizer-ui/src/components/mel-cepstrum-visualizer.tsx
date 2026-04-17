import { useCallback, useMemo, useRef } from 'react';

import Box from '@mui/material/Box';

import { useAnimationFrame } from '#src/hooks/use-animation-frame.js';

export interface MelCepstrumVisualizerProps {
  analyserNode: AnalyserNode | null;
  width: number;
  height: number;
  color: string;
}

const ML = 36; // left margin for Y labels
const MB = 18; // bottom margin for X labels
const MT = 6;
const MR = 18;

const NUM_MEL_FILTERS = 26;
const NUM_CEPSTRAL_COEFFS = 13;

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

function makeByteArray(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

function buildMelFilterbank(
  numFilters: number,
  fftSize: number,
  sampleRate: number,
): Float32Array[] {
  const numBins = fftSize / 2;
  const melMin = hzToMel(0);
  const melMax = hzToMel(sampleRate / 2);

  const binPoints = Array.from({ length: numFilters + 2 }, (_, i) => {
    const mel = melMin + (i / (numFilters + 1)) * (melMax - melMin);
    return Math.floor((melToHz(mel) / (sampleRate / 2)) * numBins);
  });

  return Array.from({ length: numFilters }, (_, m) => {
    const filter = new Float32Array(numBins);
    const left = binPoints[m] ?? 0;
    const center = binPoints[m + 1] ?? 0;
    const right = binPoints[m + 2] ?? numBins;
    for (let k = left; k <= center && k < numBins; k++) {
      filter[k] = center === left ? 1 : (k - left) / (center - left);
    }
    for (let k = center; k <= right && k < numBins; k++) {
      filter[k] = right === center ? 0 : (right - k) / (right - center);
    }
    return filter;
  });
}

function dctII(input: Float32Array, numCoeffs: number): Float32Array {
  const N = input.length;
  const result = new Float32Array(numCoeffs);
  for (let k = 0; k < numCoeffs; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += (input[n] ?? 0) * Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
    result[k] = sum;
  }
  return result;
}

export const MelCepstrumVisualizer = ({
  analyserNode,
  width,
  height,
  color,
}: MelCepstrumVisualizerProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const filterbank = useMemo(() => {
    if (!analyserNode) return null;
    return buildMelFilterbank(
      NUM_MEL_FILTERS,
      analyserNode.fftSize,
      analyserNode.context.sampleRate,
    );
  }, [analyserNode]);

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

    if (!analyserNode || !filterbank) {
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotX, midY);
      ctx.lineTo(plotX + plotW, midY);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    const binCount = analyserNode.frequencyBinCount;
    if (!freqDataRef.current || freqDataRef.current.length !== binCount) {
      freqDataRef.current = makeByteArray(binCount);
    }
    analyserNode.getByteFrequencyData(freqDataRef.current);

    const rawData = freqDataRef.current;

    const melEnergies = new Float32Array(NUM_MEL_FILTERS);
    for (let m = 0; m < NUM_MEL_FILTERS; m++) {
      const filter = filterbank[m];
      if (!filter) continue;
      let energy = 0;
      for (let k = 0; k < binCount; k++) {
        const mag = (rawData[k] ?? 0) / 255;
        energy += mag * mag * (filter[k] ?? 0);
      }
      melEnergies[m] = Math.log(energy + 1e-8);
    }

    const cepstrum = dctII(melEnergies, NUM_CEPSTRAL_COEFFS);

    let maxAbs = 0.01;
    for (let k = 1; k < NUM_CEPSTRAL_COEFFS; k++) {
      maxAbs = Math.max(maxAbs, Math.abs(cepstrum[k] ?? 0));
    }

    // Bars for coefficients 1–12
    const displayCoeffs = NUM_CEPSTRAL_COEFFS - 1; // 12
    const barWidth = plotW / displayCoeffs;

    for (let k = 1; k < NUM_CEPSTRAL_COEFFS; k++) {
      const normalized = (cepstrum[k] ?? 0) / maxAbs;
      const barH = Math.abs(normalized) * (plotH / 2);
      const i = k - 1;
      const hue = 200 + (i / displayCoeffs) * 120;
      const isPositive = normalized >= 0;
      ctx.globalAlpha = 0.3 + Math.abs(normalized) * 0.7;
      ctx.fillStyle = isPositive
        ? `hsl(${hue.toFixed(0)}, 75%, 45%)`
        : `hsl(${(hue + 180).toFixed(0)}, 65%, 40%)`;
      ctx.fillRect(
        plotX + i * barWidth + 1,
        isPositive ? midY - barH : midY,
        barWidth - 2,
        barH,
      );
    }
    ctx.globalAlpha = 1;

    // X-axis coefficient index labels (1–12)
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    for (let k = 1; k < NUM_CEPSTRAL_COEFFS; k++) {
      const i = k - 1;
      const x = plotX + (i + 0.5) * barWidth;
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plotY + plotH);
      ctx.lineTo(x, plotY + plotH + 3);
      ctx.stroke();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = color;
      ctx.fillText(`c${k.toString()}`, x, height - 4);
    }
    ctx.globalAlpha = 1;
  }, [analyserNode, filterbank, width, height, color]);

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
