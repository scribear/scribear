import React, { useEffect, useRef } from 'react';

export function FrequencyVisualizer({ analyser }: { analyser: AnalyserNode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = new Uint8Array(analyser.frequencyBinCount);

    let raf = 0;

    const draw = () => {
      // match canvas size to container size every frame (simple + robust)
      const parent = canvas.parentElement;
      if (parent) {
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
      }

      analyser.getByteFrequencyData(data);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barCount = Math.min(120, data.length);
      const step = Math.floor(data.length / barCount);
      const barW = canvas.width / barCount;

      for (let i = 0; i < barCount; i++) {
        const v = data[i * step] ?? 0;
        const barH = (v / 255) * canvas.height;

        ctx.fillStyle = 'rgba(25,118,210,0.85)';
        ctx.fillRect(i * barW, canvas.height - barH, Math.max(1, barW - 2), barH);
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />;
}