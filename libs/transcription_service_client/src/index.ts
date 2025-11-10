import TranscriptionStreamClient from './transcription_stream_client/transcription_stream_client.js';

const tsc = new TranscriptionStreamClient(
  'localhost:8000',
  'CHANGEME',
  false,
  'debug',
  null,
);

tsc.on('connected', () => {
  console.log('connected');
  // tsc.send_audio(new Blob([new ArrayBuffer(10)]));
});

tsc.on('disconnected', (code, reason) => {
  console.log('disconnected', code, reason);
});

tsc.on('ip_transcription', (text, starts, ends) => {
  console.log(text, starts, ends);
});

tsc.on('final_transcription', (text, starts, ends) => {
  console.log(text, starts, ends);
});
