/**
 * Transcription-service load driver and CPU benchmark.
 *
 * Streams speech at `/transcription_stream/<provider>` as SAFP frames, at real
 * time, from N concurrent sessions, and reports what the container spent to
 * serve them.
 *
 * Usage:
 *   node tools/asr-load/asr-load.mjs [options]
 *
 * Options:
 *   --sessions <n>      default 1    concurrent streaming sessions
 *   --seconds <n>       default 60   how long each one streams
 *   --provider <name>   default whisper   key in provider_config.json
 *   --chunk-ms <n>      default 100  frame size; the kiosk's AUDIO_CHUNK_MS
 *   --host <host>       default: the container's IP, via docker inspect
 *   --container <name>  default deployment-transcription-service-1
 *   --api-key <key>     default: TRANSCRIPTION_API_KEY from deployment/.env
 *   --wav <path>        default test_audio_files/speech/harvard_16k_mono.wav
 *   --no-stats          skip the CPU sampling (and the docker dependency)
 *   --json              machine-readable result on stdout
 *
 * Why this exists, and why it does not go through the kiosk: `npm run e2e:audio`
 * already drives the real browser, which is what you want for a correctness
 * check but not for a cost one - it puts Chromium, node-server and the browser's
 * own capture stack inside the measurement, and it cannot run two sessions at
 * once. This talks to the service directly, so the CPU it reports is the
 * service's, and it scales to as many sessions as the box will take.
 *
 * It was written to measure a bug where a single GPU session cost 2.4 cores of
 * CPU (OpenBLAS spinning a thread per core - see deployment/UPGRADING.md), and
 * the shape of that bug is why the tool reports **cost per session** rather than
 * pass/fail: throughput and transcripts looked perfect throughout. What gave it
 * away was cores-per-session, and what proved the fix was that transcripts per
 * 1000 chunks did not move (174.3 -> 176.5) while cores-per-session fell 7x.
 *
 * Requires a running stack (deployment/compose.yml).
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { WebSocket } from 'ws';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/** The only rate the service accepts, and what the fixture is stored at. */
const SAMPLE_RATE = 16000;
const DEFAULT_CONTAINER = 'deployment-transcription-service-1';

/** SAFP field keys and wire types - see libs/audio-frame-protocol. */
const FIELD_KEY_SENT_AT = 1;
const FIELD_KEY_CHUNK_ID = 2;
const WIRE_FLOAT64 = 0x02;
const WIRE_UTF8 = 0x04;

function parseArgs(argv) {
  const args = {
    sessions: 1,
    seconds: 60,
    provider: 'whisper',
    chunkMs: 100,
    host: '',
    container: DEFAULT_CONTAINER,
    apiKey: '',
    wav: join(REPO_ROOT, 'test_audio_files', 'speech', 'harvard_16k_mono.wav'),
    stats: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--no-stats') args.stats = false;
    else if (flag === '--sessions') args.sessions = Number(argv[++i]);
    else if (flag === '--seconds') args.seconds = Number(argv[++i]);
    else if (flag === '--provider') args.provider = argv[++i];
    else if (flag === '--chunk-ms') args.chunkMs = Number(argv[++i]);
    else if (flag === '--host') args.host = argv[++i];
    else if (flag === '--container') args.container = argv[++i];
    else if (flag === '--api-key') args.apiKey = argv[++i];
    else if (flag === '--wav') args.wav = argv[++i];
    else throw new Error(`Unknown option: ${flag}`);
  }
  return args;
}

/**
 * Read `deployment/.env` for the service's API key. Same plain scan as
 * tools/e2e-audio, and for the same reason: the file's values are unquoted and
 * shell-hostile, so reading it beats sourcing it.
 */
function loadDeploymentEnv() {
  const path = join(REPO_ROOT, 'deployment', '.env');
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const docker = (...argv) =>
  execFileSync('docker', argv, { encoding: 'utf8' }).trim();

/**
 * The container's IP on the compose network.
 *
 * Deliberately the default over `localhost`: nginx does not proxy
 * `/transcription_stream` - it is an internal service - and publishing its port
 * to the host would mean editing compose.yml to run a benchmark. Docker's
 * bridge network is routable from the host, so this needs no change to the
 * stack under test, which is the whole point when the thing being measured is
 * that stack's CPU.
 */
function resolveHost(container) {
  const format = '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}';
  const out = docker('inspect', container, '--format', format);
  const ip = out.split(/\s+/).filter(Boolean)[0];
  if (!ip) throw new Error(`No IP found for container ${container}.`);
  return ip;
}

/** 16-bit mono PCM payload of a RIFF file, with its format checked. */
function readPcm(path) {
  if (!existsSync(path)) throw new Error(`No such WAV: ${path}`);
  const buf = readFileSync(path);
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        channels: body.readUInt16LE(2),
        rate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    }
    if (id === 'data') data = body;
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error(`${path} is not a usable RIFF WAV.`);
  if (fmt.rate !== SAMPLE_RATE || fmt.channels !== 1 || fmt.bits !== 16) {
    throw new Error(
      `Need ${SAMPLE_RATE}Hz mono 16-bit, got ${fmt.rate}Hz ` +
        `${fmt.channels}ch ${fmt.bits}-bit.`,
    );
  }
  return data;
}

/**
 * Wrap a PCM slice in its own 44-byte WAV header.
 *
 * Every chunk is a self-contained container because that is what the service's
 * AudioDecoder expects - it opens each frame's payload with soundfile and
 * validates the header's rate and channel count - so a bare PCM slice is
 * rejected. The same thing the live-stack crosscheck suite does.
 */
function wavContainer(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** One SAFP frame: header, chunk_id, sent_at, audio, CRC-32. */
function encodeFrame(chunkId, audio, sentAt) {
  const fieldHeader = (key, wireType, length) => {
    const b = Buffer.alloc(4);
    b.writeUInt8(key, 0);
    b.writeUInt8(wireType, 1);
    b.writeUInt16LE(length, 2);
    return b;
  };
  const id = Buffer.from(chunkId, 'utf8');
  const timestamp = Buffer.alloc(8);
  timestamp.writeDoubleLE(sentAt, 0);
  const body = Buffer.concat([
    Buffer.from([0x53, 0x41, 1, 2]), // 'S', 'A', version, field_count
    fieldHeader(FIELD_KEY_CHUNK_ID, WIRE_UTF8, id.length),
    id,
    fieldHeader(FIELD_KEY_SENT_AT, WIRE_FLOAT64, timestamp.length),
    timestamp,
    audio,
  ]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(body) >>> 0, 0);
  return Buffer.concat([body, crc]);
}

/**
 * Stream `chunks` at real time for `seconds`, looping the fixture as needed.
 *
 * Credentials go out the moment the socket opens and before any audio: the
 * service closes 1008 on an unauthenticated binary frame, so a frame that
 * overtakes the handshake fails the run for a reason that has nothing to do
 * with load.
 */
function runSession({ index, url, apiKey, chunks, chunkMs, seconds }) {
  return new Promise((resolve) => {
    const stats = {
      session: index,
      chunksSent: 0,
      messages: 0,
      finals: 0,
      words: 0,
      closed: null,
      errors: [],
    };
    const ws = new WebSocket(url);
    const startedAt = Date.now();
    let timer = null;
    let next = 0;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', api_key: apiKey }));
      ws.send(
        JSON.stringify({
          type: 'config',
          config: {},
          session_uid: `asr-load-session-${index}`,
          room_uid: `asr-load-room-${index}`,
        }),
      );
      timer = setInterval(() => {
        if (Date.now() - startedAt >= seconds * 1000) {
          clearInterval(timer);
          ws.close();
          return;
        }
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          encodeFrame(
            `s${index}-c${stats.chunksSent}`,
            chunks[next++ % chunks.length],
            Date.now(),
          ),
        );
        stats.chunksSent++;
      }, chunkMs);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      stats.messages++;
      try {
        const message = JSON.parse(data.toString());
        if (message.final?.text?.length) {
          stats.finals++;
          stats.words += message.final.text.length;
        }
      } catch {
        stats.errors.push('unparseable server message');
      }
    });

    ws.on('error', (err) => stats.errors.push(String(err.message ?? err)));
    ws.on('close', (code, reason) => {
      if (timer) clearInterval(timer);
      // 1000/1005 are this tool hanging up on itself once its time is up.
      const clean = code === 1000 || code === 1005;
      stats.closed = `${code}${reason?.length ? ` ${reason}` : ''}`;
      if (!clean) stats.errors.push(`closed ${stats.closed}`);
      resolve(stats);
    });
  });
}

/**
 * Sample the container's CPU until `stop()` is called.
 *
 * `docker stats --no-stream` per sample rather than one streaming invocation:
 * the streaming form emits ANSI cursor control and its first row is a
 * since-boot average, both of which have to be undone before the numbers mean
 * anything. Each sample is one interval's reading and takes ~1s, which is why
 * the loop does not sleep between them.
 *
 * Async, and that is not a style preference: `execFileSync` would block the
 * event loop for that whole second, stalling every session's frame timer. The
 * load pattern being measured would then be an artefact of the measurement.
 */
function sampleCpu(container) {
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const { stdout } = await execFileAsync('docker', [
          'stats',
          '--no-stream',
          '--format',
          '{{.CPUPerc}}',
          container,
        ]);
        const percent = Number(stdout.trim().replace('%', ''));
        if (Number.isFinite(percent)) samples.push(percent);
      } catch {
        // A restart mid-run should not lose the samples already taken.
        running = false;
      }
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      // The sample in flight when streaming stopped covers part of the
      // teardown, so it reads low for a reason that is not the service's doing.
      // Dropped, but only when enough remain for the mean to still mean
      // something.
      return samples.length >= 3 ? samples.slice(0, -1) : samples;
    },
  };
}

const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function summarise(args, sessions, cpuSamples) {
  const chunksSent = sessions.reduce((n, s) => n + s.chunksSent, 0);
  const words = sessions.reduce((n, s) => n + s.words, 0);
  const messages = sessions.reduce((n, s) => n + s.messages, 0);
  const finals = sessions.reduce((n, s) => n + s.finals, 0);
  const cpuMean = mean(cpuSamples);

  const failures = [];
  for (const s of sessions) {
    if (s.errors.length) failures.push(`session ${s.session}: ${s.errors[0]}`);
    else if (s.messages === 0) {
      failures.push(`session ${s.session}: no transcripts arrived`);
    }
  }

  return {
    ok: failures.length === 0,
    sessions: args.sessions,
    seconds: args.seconds,
    provider: args.provider,
    chunksSent,
    messages,
    finals,
    words,
    // Normalised so runs of different lengths compare directly. The pair to
    // watch across a change: rates hold, cost moves.
    transcriptsPer1000Chunks: chunksSent
      ? Number(((messages / chunksSent) * 1000).toFixed(1))
      : null,
    wordsPer1000Chunks: chunksSent
      ? Number(((words / chunksSent) * 1000).toFixed(1))
      : null,
    cpuPercentMean: cpuSamples.length ? Number(cpuMean.toFixed(1)) : null,
    cpuPercentMax: cpuSamples.length ? Math.max(...cpuSamples) : null,
    coresPerSession: cpuSamples.length
      ? Number((cpuMean / 100 / args.sessions).toFixed(2))
      : null,
    cpuSampleCount: cpuSamples.length,
    perSession: sessions,
    failures,
  };
}

function report(result, args) {
  console.log('\n=== RESULT ===');
  console.log(`provider              : ${result.provider}`);
  console.log(`sessions x seconds    : ${result.sessions} x ${result.seconds}`);
  console.log(`chunks sent           : ${result.chunksSent}`);
  console.log(`transcript messages   : ${result.messages}`);
  console.log(`finalized words       : ${result.words}`);
  console.log(`  per 1000 chunks     : ${result.wordsPer1000Chunks}`);
  console.log(`transcripts/1000 chunk: ${result.transcriptsPer1000Chunks}`);
  if (result.cpuSampleCount) {
    console.log(
      `container CPU         : ${result.cpuPercentMean}% mean, ` +
        `${result.cpuPercentMax}% max (${result.cpuSampleCount} samples)`,
    );
    console.log(`cores per session     : ${result.coresPerSession}`);
  } else if (args.stats) {
    console.log('container CPU         : no samples taken');
  }
  console.log(
    result.ok ? '\nPASS' : `\nFAIL\n - ${result.failures.join('\n - ')}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.json ? () => {} : (m) => console.log(m);

  const apiKey = args.apiKey || loadDeploymentEnv().TRANSCRIPTION_API_KEY || '';
  if (!apiKey) {
    throw new Error(
      'No API key: pass --api-key, or set TRANSCRIPTION_API_KEY in ' +
        'deployment/.env.',
    );
  }
  const host = args.host || resolveHost(args.container);
  const url = `ws://${host}/transcription_stream/${args.provider}`;

  const pcm = readPcm(args.wav);
  const bytesPerChunk = Math.round((SAMPLE_RATE * 2 * args.chunkMs) / 1000);
  const chunks = [];
  for (let o = 0; o + bytesPerChunk <= pcm.length; o += bytesPerChunk) {
    chunks.push(wavContainer(pcm.subarray(o, o + bytesPerChunk)));
  }
  if (!chunks.length) {
    throw new Error(`${args.wav} is shorter than one ${args.chunkMs}ms chunk.`);
  }

  log(`--- ${url}`);
  log(
    `--- ${chunks.length} x ${args.chunkMs}ms chunks ` +
      `(${((chunks.length * args.chunkMs) / 1000).toFixed(1)}s of audio, looped)`,
  );
  log(`--- streaming ${args.sessions} session(s) for ${args.seconds}s`);

  const cpu = args.stats ? sampleCpu(args.container) : null;
  const sessions = await Promise.all(
    Array.from({ length: args.sessions }, (_, index) =>
      runSession({
        index,
        url,
        apiKey,
        chunks,
        chunkMs: args.chunkMs,
        seconds: args.seconds,
      }),
    ),
  );
  const cpuSamples = cpu ? await cpu.stop() : [];

  const result = summarise(args, sessions, cpuSamples);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else report(result, args);

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
