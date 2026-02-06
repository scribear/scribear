// import React, { useEffect, useRef } from 'react';

// type Props = {
//   analyser: AnalyserNode | null; 
// };

// export function WaveformVisualizer({ analyser }: Props) {
//   const canvasRef = useRef<HTMLCanvasElement | null>(null);
//   const rafRef = useRef<number>(0); 

//   useEffect(() => {
//     if (!analyser) return;

//     const canvas = canvasRef.current;
//     if (!canvas) return;

//     const ctx = canvas.getContext('2d');
//     if (!ctx) return;

//     const bufferLength = analyser.frequencyBinCount;
//     const data = new Uint8Array(bufferLength); 

//     const resizeCanvas = () => {
//       const parent = canvas.parentElement;
//       if (!parent) return;

//       const dpr = window.devicePixelRatio || 1;

//       const width = parent.clientWidth;
//       const height = parent.clientHeight;

//       canvas.width = width * dpr;
//       canvas.height = height * dpr;

//       canvas.style.width = `${width}px`;
//       canvas.style.height = `${height}px`;

//       ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // scale drawing
//     };

//     resizeCanvas();

//     const resizeObserver = new ResizeObserver(resizeCanvas);
//     resizeObserver.observe(canvas);

//     const draw = () => {
//       analyser.getByteTimeDomainData(data);

//       ctx.clearRect(0, 0, canvas.width, canvas.height);

//       const mid = canvas.height / 2;

//       // center line
//       ctx.strokeStyle = 'rgba(0,0,0,0.15)';
//       ctx.beginPath();
//       ctx.moveTo(0, mid);
//       ctx.lineTo(canvas.width, mid);
//       ctx.stroke();

//       // waveform
//       ctx.strokeStyle = 'rgba(46,125,50,0.9)';
//       ctx.lineWidth = 2;
//       ctx.beginPath();

//       const sliceWidth = canvas.width / bufferLength;

//       let x = 0;

//       for (let i = 0; i < bufferLength; i++) {
//         const v = data[i] / 128.0; // normalize around 1
//         const y = v * mid;

//         if (i === 0) ctx.moveTo(x, y);
//         else ctx.lineTo(x, y);

//         x += sliceWidth;
//       }

//       ctx.stroke();

//       rafRef.current = requestAnimationFrame(draw);
//     };

//     rafRef.current = requestAnimationFrame(draw);

//     return () => {
//       cancelAnimationFrame(rafRef.current);
//       resizeObserver.disconnect(); 
//     };
//   }, [analyser]);

//   return (
//     <canvas
//       ref={canvasRef}
//       style={{
//         width: '100%',
//         height: '100%',
//         display: 'block', // avoids inline canvas spacing bug
//       }}
//     />
//   );
// }