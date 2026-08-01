/**
 * Two-room live demo harness: provisions real rooms, streams real audio into
 * them from headless source devices, and asserts a real viewer sees captions.
 *
 * Usage:
 *   node tools/demo-e2e/demo-e2e.mjs [options]
 *
 * Options:
 *   --base-url <url>       default https://localhost (self-signed certs accepted)
 *   --rooms <n>            default 2. Room A is on-demand, room B is an AUTO
 *                          session from an auto-session window covering now;
 *                          any further rooms are on-demand. Raise it to probe
 *                          the transcription-service admission ceiling on
 *                          purpose.
 *   --stream-seconds <n>   default 90. How long to wait for every assertion in
 *                          a room to be satisfied before calling it a failure.
 *   --hold                 do not tear down. Keeps audio flowing and reprints a
 *                          freshly minted join code / viewer URL before the old
 *                          one expires, until Ctrl-C. This is the live-demo mode.
 *   --keep                 run the assertions, then leave the rooms in place.
 *   --env-file <path>      where to read SESSION_MANAGER_API_KEY / ORIGIN from.
 *                          Defaults to <repo>/deployment/.env, then
 *                          <repo>/../deployment/.env.
 *   --json                 machine-readable result on stdout
 *
 * Why this exists: every part of this system has a test except the one thing a
 * demo actually needs — a room somebody just created, with captions arriving in
 * a browser. The demo that prompted this failed with a viewer stuck on
 * "Reconnecting…" while the backend was entirely healthy, because the *idle*
 * state (`sourceDeviceConnected: false`) was rendered as a fault. Nothing in CI
 * could see that: it needs a real room, a real source, and a real viewer socket
 * observing the transition out of idle.
 *
 * So the assertions here are deliberately about the `sessionStatus` sequence
 * and not only about transcript text:
 *
 *   1. the viewer authenticates (`authOk`);
 *   2. the first status is the idle one (both flags false) — the state that was
 *      being mis-rendered;
 *   3. `sourceDeviceConnected` goes false -> true, and only then does
 *      `transcriptionServiceConnected` go false -> true. The order is pinned:
 *      node-server dials the transcription service *from* `registerSource`, so
 *      any build where the service flag leads the source flag has changed that
 *      contract;
 *   4. at least one `transcript` arrives with non-empty `final.text`.
 *
 * Requires a running stack and a built repo (`npm run build`) — the source
 * device is `@scribear/test-audio-source`, the same engine the canary and the
 * operator test-audio devices run on, rather than a second implementation of
 * device auth, WAV chunking and SAFP framing that could drift from it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TRANSCRIPTION_STREAM_CLIENT_ROUTE,
  TranscriptionServiceDisconnectReason,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import { DEVICE_TOKEN_COOKIE_NAME } from '@scribear/session-manager-schema';
import {
  DeviceAuthClient,
  GOOD_PARAM_DEFAULTS,
  GoodEngine,
  TestAudioStream,
  connectStreamSocket,
  createSeededRng,
  decodeWav,
  sliceIntoChunks,
  waitForSocketOpen,
} from '@scribear/test-audio-source';

// The stack under test terminates TLS with a self-signed certificate, exactly
// as the puppeteer-based harnesses assume (`acceptInsecureCerts`). Both `fetch`
// and the global `WebSocket` honour this; neither opens a socket at import
// time, so setting it here — after the hoisted imports — is early enough.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/** Speech fixture the synthetic sources loop. */
const WAV = join(
  REPO_ROOT,
  'test_audio_files',
  'speech',
  'harvard_16k_mono.wav',
);

/** 100 ms matches the kiosk's `AUDIO_CHUNK_MS`, so frames look like a kiosk's. */
const CHUNK_MS = 100;

/**
 * How long one streaming segment lasts before the source re-authenticates.
 *
 * A session token lives 5 minutes. The socket itself is only authenticated
 * once, so an established stream outlives its token — but a *reconnect* after
 * expiry would fail, which is precisely the state a long `--hold` demo would
 * drift into. Re-running the streamer inside the token's lifetime mints a fresh
 * one each cycle, at the cost of a sub-second gap in audio between segments.
 */
const SOURCE_SEGMENT_MS = 4 * 60 * 1000;

/**
 * How long after a join code's `validEnd` to ask for the next one.
 *
 * Deliberately keyed off the code's own expiry rather than a fixed interval,
 * because `admin-fetch-join-code` does *not* rotate on demand: it returns the
 * code covering `now` and mints a new one only once none is current
 * (`_findOrMintCurrentJoinCode`). Polling it every four minutes therefore
 * reprints the *same* code with 60 s of life left and then says nothing for
 * another four minutes — an operator following the output would be handing out
 * a link that dies a minute later.
 */
const JOIN_CODE_REFETCH_SLACK_MS = 2000;

/** Every day, so the AUTO window covers "now" whatever day the demo runs on. */
const ALL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/**
 * How far back the AUTO window's `activeStart` is placed.
 *
 * "In the past" is not enough, and getting this wrong costs an hour: the
 * materializer drops any occurrence whose *start* precedes `activeStart`
 * (`inRange` in `schedule-materializer.ts`), so a window created at 16:39 UTC
 * with `activeStart` one hour earlier loses today's 00:00 occurrence entirely
 * and the first AUTO session materialises tomorrow. The occurrence is clipped
 * to `now` only once it has survived that test. A week back clears the
 * day-boundary for any local start time in any timezone.
 */
const AUTO_WINDOW_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = {
    baseUrl: 'https://localhost',
    rooms: 2,
    streamSeconds: 90,
    hold: false,
    keep: false,
    envFile: '',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--hold') args.hold = true;
    else if (flag === '--keep') args.keep = true;
    else if (flag === '--base-url') args.baseUrl = argv[++i];
    else if (flag === '--env-file') args.envFile = argv[++i];
    else if (flag === '--rooms') args.rooms = Number(argv[++i]);
    else if (flag === '--stream-seconds')
      args.streamSeconds = Number(argv[++i]);
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!Number.isInteger(args.rooms) || args.rooms < 1) {
    throw new Error('--rooms must be a positive integer');
  }
  return args;
}

/**
 * Read the deployment env for the admin key and the public origin.
 *
 * A plain scan rather than a dotenv dependency, matching `tools/e2e-audio`. The
 * default search order matters on a box where the *running* stack lives outside
 * the repo: the checkout may have no `deployment/.env` at all, and the keys that
 * work belong to whichever compose project is actually up.
 */
function loadDeploymentEnv(explicitPath) {
  const candidates = [
    explicitPath ? resolve(explicitPath) : null,
    join(REPO_ROOT, 'deployment', '.env'),
    join(REPO_ROOT, '..', 'deployment', '.env'),
  ].filter(Boolean);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const env = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
    return { env, path };
  }
  throw new Error(
    `No deployment .env found. Tried: ${candidates.join(', ')}. ` +
      'Pass --env-file, or set SESSION_MANAGER_API_KEY in the environment.',
  );
}

/** Thin session-manager client: admin-key calls plus the unauthenticated ones. */
function createApi(baseUrl, adminKey) {
  const root = `${baseUrl}/api/session-manager/v1`;

  async function call(method, path, body, { auth }) {
    const headers = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${adminKey}`;
    const res = await fetch(`${root}/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const code = parsed?.code ? ` ${parsed.code}` : '';
      const message = parsed?.message ? `: ${parsed.message}` : ` ${text}`;
      throw new Error(
        `${method} ${path} -> ${res.status}${code}${message.slice(0, 300)}`,
      );
    }
    return { body: parsed, res };
  }

  return {
    post: async (path, body) =>
      (await call('POST', path, body, { auth: true })).body,
    get: async (path) =>
      (await call('GET', path, undefined, { auth: true })).body,
    /** Routes that take no credential at all — the join code / activation code is the credential. */
    postPublic: async (path, body) =>
      await call('POST', path, body, { auth: false }),
  };
}

/**
 * Register a device and immediately activate it, returning its DEVICE_TOKEN.
 *
 * The two calls are adjacent on purpose: an activation code is single-use and
 * expires 5 minutes after registration, so anything that separates them (a
 * prompt, a slow room create) turns a rerun into a dead device.
 *
 * `activate-device` is the only place the 64-byte secret is ever revealed, and
 * it is revealed in a `Set-Cookie` header rather than the body — which is why
 * this reads `getSetCookie()` instead of the JSON.
 */
async function provisionDevice(api, name) {
  const device = await api.post('device-management/register-device', { name });
  const { res } = await api.postPublic('device-management/activate-device', {
    activationCode: device.activationCode,
  });

  const cookies = res.headers.getSetCookie();
  const prefix = `${DEVICE_TOKEN_COOKIE_NAME}=`;
  const cookie = cookies.find((c) => c.startsWith(prefix));
  if (!cookie) {
    throw new Error(
      `activate-device set no ${DEVICE_TOKEN_COOKIE_NAME} cookie (got: ${cookies.join(', ') || 'none'})`,
    );
  }
  const value = decodeURIComponent(cookie.slice(prefix.length).split(';')[0]);
  return { deviceUid: device.deviceUid, deviceToken: value };
}

/**
 * Provision the device, room and session for one demo room.
 *
 * `record` is pushed to before each step that can fail, so a run that dies
 * halfway still has enough in the caller's list for teardown to remove it.
 */
async function provisionRoom(api, { label, kind, stamp, log }, record) {
  const name = `${stamp}-${label.toLowerCase()}`;
  const room = {
    label,
    kind,
    name,
    device: null,
    roomUid: null,
    session: null,
  };
  record.push(room);

  room.device = await provisionDevice(api, `${name}-src`);
  log(
    `--- [${label}] device ${room.device.deviceUid} registered and activated`,
  );

  const created = await api.post('room-management/create-room', {
    name,
    // UTC keeps the auto-session window's local times equal to wall-clock UTC,
    // so "does the window contain now" needs no timezone arithmetic to reason
    // about when a run fails.
    timezone: 'UTC',
    autoSessionEnabled: kind === 'auto',
    sourceDeviceUids: [room.device.deviceUid],
  });
  room.roomUid = created.uid;
  log(`--- [${label}] room ${room.roomUid} created (${kind})`);

  if (kind === 'on-demand') {
    room.session = await api.post(
      'schedule-management/create-on-demand-session',
      {
        roomUid: room.roomUid,
        name: `${name}-session`,
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      },
    );
  } else {
    // A backdated `activeStart` is the whole trick: the admin dialog forces it
    // into the future, so a window created through the UI may not materialise a
    // slot until tomorrow. The API accepts a past start and reconciles a slot
    // covering now immediately.
    await api.post('schedule-management/create-auto-session-window', {
      roomUid: room.roomUid,
      localStartTime: '00:00',
      localEndTime: '23:59',
      daysOfWeek: ALL_DAYS,
      activeStart: new Date(Date.now() - AUTO_WINDOW_BACKDATE_MS).toISOString(),
      activeEnd: null,
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
      transcriptionProviderId: 'whisper',
      transcriptionStreamConfig: {},
    });
    room.session = await waitForActiveSession(api, room.roomUid, 30_000);
  }
  log(`--- [${label}] session ${room.session.uid} (${room.session.type})`);

  return room;
}

/** Poll `get-active-session` until the reconciler has materialised a slot. */
async function waitForActiveSession(api, roomUid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await api.get(
      `schedule-management/get-active-session/${roomUid}`,
    );
    if (session) return session;
    if (Date.now() > deadline) {
      throw new Error(
        `No AUTO session materialised in room ${roomUid} within ${timeoutMs}ms. ` +
          'Check that autoSessionEnabled is true and the window covers now.',
      );
    }
    await sleep(1000);
  }
}

/**
 * Mint a join code for a session.
 *
 * Join codes are minted **lazily**: creating a session does not create one, and
 * the room detail page does not show one. Nothing has a code until somebody
 * reads it here (or opens `/admin/sessions/:uid`), which is the step that was
 * missing from the demo runbook.
 */
async function fetchJoinCode(api, sessionUid) {
  const result = await api.post('session-auth/admin-fetch-join-code', {
    sessionUid,
  });
  if (result.status !== 'ok') {
    throw new Error(
      `admin-fetch-join-code returned "${result.status}" for ${sessionUid} ` +
        '("not-active" = outside its effective window; "no-join-scopes" = the ' +
        'session was created with an empty joinCodeScopes).',
    );
  }
  return result;
}

/** The operator-facing link. A hash fragment, and the trailing slash matters. */
function viewerUrl(origin, joinCode) {
  const config = Buffer.from(
    JSON.stringify({ clientSessionConfig: { joinCode } }),
  ).toString('base64');
  return `${origin}/client/#config=${config}`;
}

/**
 * Open a viewer socket the way a browser viewer does: exchange the join code
 * (unauthenticated — the code *is* the credential), then speak the client route.
 *
 * Deliberately not the source socket's own receive scope: a source token also
 * carries `RECEIVE_TRANSCRIPTIONS`, but reading captions back on it would skip
 * `/client` and the fan-out path, so a pass would be a claim about a code path
 * no real viewer takes.
 */
async function openViewer(api, baseUrl, joinCode) {
  const { body: exchanged } = await api.postPublic(
    'session-auth/exchange-join-code',
    { joinCode },
  );

  const observed = {
    authOk: false,
    statuses: [],
    finals: [],
    closes: [],
    errors: [],
    atCapacity: false,
  };

  const socket = connectStreamSocket(
    baseUrl,
    TRANSCRIPTION_STREAM_CLIENT_ROUTE,
    exchanged.sessionUid,
    exchanged.sessionToken,
  );

  // Registered synchronously, before the socket can have opened, so the
  // very first `sessionStatus` — the idle one this harness exists to pin — is
  // never missed.
  socket.on('message', (msg) => {
    if (msg.type === TranscriptionStreamServerMessageType.AUTH_OK) {
      observed.authOk = true;
    } else if (
      msg.type === TranscriptionStreamServerMessageType.SESSION_STATUS
    ) {
      observed.statuses.push({
        atMs: Date.now(),
        source: msg.sourceDeviceConnected,
        service: msg.transcriptionServiceConnected,
        reason: msg.transcriptionServiceDisconnectReason ?? null,
      });
      if (
        msg.transcriptionServiceDisconnectReason ===
        TranscriptionServiceDisconnectReason.AT_CAPACITY
      ) {
        observed.atCapacity = true;
      }
    } else if (msg.type === TranscriptionStreamServerMessageType.TRANSCRIPT) {
      const text = (msg.final?.text ?? []).join(' ').trim();
      if (text) observed.finals.push(text);
    }
  });
  socket.on('close', (code, reason) => {
    observed.closes.push({ code, reason });
    // 1013 is the transcription service refusing admission, relayed down.
    if (code === 1013) observed.atCapacity = true;
  });
  socket.on('error', (err) => {
    observed.errors.push(err instanceof Error ? err.message : String(err));
  });

  await waitForSocketOpen(socket, 15_000);
  return { socket, observed, sessionUid: exchanged.sessionUid };
}

/** A logger shaped like `BaseLogger`, for the streaming engine's debug lines. */
function quietLogger() {
  const noop = () => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
}

/**
 * Frames a source has put on the wire so far.
 *
 * Read live from the in-flight segment rather than only from finished ones:
 * the assertions are evaluated while the stream is still running, so a
 * segment-end-only total would report 0 on every passing run and be useless in
 * the one case it matters — explaining a run with no transcript.
 */
function framesSent(state) {
  return (
    state.framesFromEndedSegments + (state.stream?.counters.framesSent ?? 0)
  );
}

/**
 * Drive a headless source into a room until `stopAtMs`, re-authenticating each
 * segment. Never throws: the caller reports on the assertions either way, and
 * an escaping error here would lose the viewer's evidence with it.
 */
async function runSource(room, chunks, baseUrl, stopAtMs, state) {
  const auth = new DeviceAuthClient({
    sessionManagerBaseUrl: baseUrl,
    deviceToken: room.device.deviceToken,
    timeoutMs: 10_000,
  });
  const engine = new GoodEngine(
    GOOD_PARAM_DEFAULTS,
    createSeededRng(room.roomUid.charCodeAt(0)),
  );

  let consecutiveErrors = 0;
  while (!state.stopRequested && Date.now() < stopAtMs) {
    const stream = new TestAudioStream(
      { nodeServerBaseUrl: baseUrl, upstreamWaitMs: 20_000 },
      auth,
      engine,
      quietLogger(),
    );
    state.stream = stream;
    const deadline = Math.min(Date.now() + SOURCE_SEGMENT_MS, stopAtMs);
    const result = await stream.run(chunks, deadline);
    state.framesFromEndedSegments += stream.counters.framesSent;
    // Cleared so the live read in `framesSent` cannot double-count a segment
    // that has already been rolled into the total.
    state.stream = null;

    if (result.error === null) {
      consecutiveErrors = 0;
      continue;
    }
    state.errors.push(result.error);
    if (++consecutiveErrors >= 3) {
      state.gaveUp = true;
      return;
    }
    await sleep(2000);
  }
}

/** Turn a room's observations into named, ordered assertions. */
function evaluate(room, observed, source) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push(
    'viewer authenticated (authOk)',
    observed.authOk,
    observed.authOk
      ? 'Join code exchanged and the client socket was accepted.'
      : `No authOk. closes=${JSON.stringify(observed.closes)} errors=${observed.errors.join('; ')}`,
  );

  const first = observed.statuses[0] ?? null;
  push(
    'first sessionStatus is the idle state (both flags false)',
    first !== null && first.source === false && first.service === false,
    first === null
      ? 'No sessionStatus was ever received.'
      : `first status: sourceDeviceConnected=${first.source}, transcriptionServiceConnected=${first.service}`,
  );

  const sourceAt = observed.statuses.findIndex((s) => s.source === true);
  const serviceAt = observed.statuses.findIndex((s) => s.service === true);
  push(
    'sourceDeviceConnected went false -> true',
    sourceAt !== -1,
    sourceAt !== -1
      ? `at status #${sourceAt}`
      : `never; the headless source never registered. source errors: ${source.errors.join('; ') || 'none'}`,
  );
  push(
    'transcriptionServiceConnected went false -> true',
    serviceAt !== -1,
    serviceAt !== -1
      ? `at status #${serviceAt}`
      : observed.atCapacity
        ? 'never — the transcription service refused admission (at-capacity).'
        : 'never; node-server never established an upstream connection.',
  );
  push(
    'the source flag led the service flag',
    sourceAt !== -1 && serviceAt !== -1 && sourceAt <= serviceAt,
    sourceAt === -1 || serviceAt === -1
      ? 'not applicable — one of the transitions never happened.'
      : `sourceDeviceConnected at #${sourceAt}, transcriptionServiceConnected at #${serviceAt}. ` +
          'node-server dials the upstream from registerSource, so the reverse order means that contract changed.',
  );

  push(
    'a transcript arrived with non-empty final text',
    observed.finals.length > 0,
    observed.finals.length > 0
      ? `${observed.finals.length} final fragment(s); first: "${observed.finals[0].slice(0, 80)}"`
      : `no final transcript in the run window (${framesSent(source)} audio frames were sent).`,
  );

  return checks;
}

function statusTrail(observed) {
  return observed.statuses
    .map(
      (s) =>
        `${s.source ? 'S' : '-'}${s.service ? 'T' : '-'}${s.reason ? `(${s.reason})` : ''}`,
    )
    .join(' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (...m) => {
    if (!args.json) console.log(...m);
  };

  const { env, path: envPath } = loadDeploymentEnv(args.envFile);
  const adminKey =
    process.env.SESSION_MANAGER_API_KEY || env.SESSION_MANAGER_API_KEY;
  if (!adminKey) {
    throw new Error(`${envPath} has no SESSION_MANAGER_API_KEY.`);
  }
  const origin = env.ORIGIN || args.baseUrl;
  log(`--- keys from ${envPath}; origin ${origin}`);

  const api = createApi(args.baseUrl, adminKey);
  const wav = decodeWav(readFileSync(WAV));
  const chunks = sliceIntoChunks(wav, CHUNK_MS);

  const stamp = `demo-${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const plans = Array.from({ length: args.rooms }, (_, i) => ({
    label: String.fromCharCode(65 + i),
    // Room B is the AUTO one; the rest are on-demand, so `--rooms 3` probes the
    // admission ceiling without inventing a third session kind.
    kind: i === 1 ? 'auto' : 'on-demand',
  }));

  const rooms = [];
  const viewers = [];
  const sources = [];
  let capacityRefusal = false;

  try {
    // ---- Provision every room before opening any socket, so all the
    // operator-facing artifacts can be printed together and a human can be
    // watching in a browser before audio starts. ----
    for (const plan of plans) {
      await provisionRoom(api, { ...plan, stamp, log }, rooms);
    }

    for (const room of rooms) {
      const code = await fetchJoinCode(api, room.session.uid);
      room.joinCode = code.joinCode;
      room.joinCodeValidEnd = code.validEnd;
      room.viewerUrl = viewerUrl(origin, code.joinCode);
    }

    if (!args.json) {
      console.log('');
      for (const room of rooms) {
        console.log(`=== room ${room.label} (${room.kind}) ===`);
        console.log(`  room     : ${room.roomUid}`);
        console.log(`  device   : ${room.device.deviceUid}`);
        console.log(`  session  : ${room.session.uid}`);
        console.log(
          `  joinCode : ${room.joinCode}  (valid until ${room.joinCodeValidEnd})`,
        );
        console.log(`  viewer   : ${room.viewerUrl}`);
      }
      console.log('');
    }

    // ---- Viewers first. The idle-state assertion only means something if the
    // viewer is listening before any source exists. ----
    for (const room of rooms) {
      log(`--- [${room.label}] opening viewer socket`);
      viewers.push(await openViewer(api, args.baseUrl, room.joinCode));
    }

    // ---- Then the sources. ----
    const stopAtMs = args.hold
      ? Date.now() + 24 * 60 * 60 * 1000
      : Date.now() + args.streamSeconds * 1000 + 15_000;
    for (const room of rooms) {
      const state = {
        stopRequested: false,
        gaveUp: false,
        framesFromEndedSegments: 0,
        errors: [],
        stream: null,
      };
      sources.push(state);
      log(`--- [${room.label}] starting headless source`);
      // The rejection handler is attached here rather than where `done` is
      // awaited in `finally`: a throw before then would otherwise surface as an
      // unhandled rejection warning instead of a named source error.
      state.done = runSource(room, chunks, args.baseUrl, stopAtMs, state).catch(
        (err) => {
          state.errors.push(err instanceof Error ? err.message : String(err));
          state.gaveUp = true;
        },
      );
    }

    // ---- Wait for every room to satisfy every assertion, or time out. ----
    const deadline = Date.now() + args.streamSeconds * 1000;
    log(`--- waiting up to ${args.streamSeconds}s for transcripts`);
    for (;;) {
      const done = rooms.every((_, i) => {
        const o = viewers[i].observed;
        return (
          o.statuses.some((s) => s.source) &&
          o.statuses.some((s) => s.service) &&
          o.finals.length > 0
        );
      });
      // Any source that has given up has already failed the run, so there is
      // nothing left to wait out — stop and report rather than burn the window.
      const stuck = sources.some((s) => s.gaveUp);
      if (done || stuck || Date.now() > deadline) break;
      await sleep(500);
    }

    for (let i = 0; i < rooms.length; i++) {
      rooms[i].checks = evaluate(rooms[i], viewers[i].observed, sources[i]);
      rooms[i].statusTrail = statusTrail(viewers[i].observed);
      rooms[i].transcript = viewers[i].observed.finals.join(' ');
      rooms[i].framesSent = framesSent(sources[i]);
      rooms[i].sourceErrors = sources[i].errors;
      if (viewers[i].observed.atCapacity) capacityRefusal = true;
    }

    // ---- Live-demo mode: stop asserting, keep the room usable. ----
    if (args.hold) {
      // The harness viewers are instruments, not part of the demo, and their
      // session tokens expire in 5 minutes with no refresh path here. Close
      // them and let the browser be the viewer.
      for (const viewer of viewers) viewer.socket.terminate(1000, 'hold');
      console.log('\n--- --hold: streaming continues. Ctrl-C to stop.\n');
      let stopped = false;
      process.on('SIGINT', () => {
        stopped = true;
      });
      for (const room of rooms) {
        room.nextCodeFetchAtMs =
          Date.parse(room.joinCodeValidEnd) + JOIN_CODE_REFETCH_SLACK_MS;
      }
      while (!stopped) {
        // Polled in short slices rather than one long sleep: registering a
        // SIGINT handler suppresses Node's default exit, so a single multi-minute
        // await would leave Ctrl-C looking ignored for minutes.
        await sleep(250);
        if (stopped) break;
        for (const room of rooms) {
          if (Date.now() < room.nextCodeFetchAtMs) continue;
          try {
            const code = await fetchJoinCode(api, room.session.uid);
            room.nextCodeFetchAtMs =
              Date.parse(code.validEnd) + JOIN_CODE_REFETCH_SLACK_MS;
            if (code.joinCode === room.joinCode) continue;
            room.joinCode = code.joinCode;
            room.viewerUrl = viewerUrl(origin, code.joinCode);
            console.log(
              `[${new Date().toISOString()}] room ${room.label} joinCode ${code.joinCode} (until ${code.validEnd})`,
            );
            console.log(`  ${room.viewerUrl}`);
          } catch (err) {
            room.nextCodeFetchAtMs = Date.now() + 15_000;
            console.log(
              `[${new Date().toISOString()}] room ${room.label} join code refresh failed: ${err.message}`,
            );
          }
        }
      }
    }
  } finally {
    for (const state of sources) state.stopRequested = true;
    for (const state of sources) state.stream?.stop();
    await Promise.allSettled(sources.map((s) => s.done));
    for (const viewer of viewers) {
      try {
        viewer.socket.terminate(1000, 'demo-e2e-complete');
      } catch {
        // already gone
      }
    }

    if (args.hold || args.keep) {
      log(
        `--- kept ${rooms.length} room(s): ${rooms.map((r) => r.roomUid).join(', ')}`,
      );
    } else {
      for (const room of rooms) {
        // Room first: it cascades sessions, windows and memberships, and a
        // device cannot be deleted while it is still its room's source.
        try {
          if (room.roomUid) {
            await api.post('room-management/delete-room', {
              roomUid: room.roomUid,
            });
          }
          if (room.device) {
            await api.post('device-management/delete-device', {
              deviceUid: room.device.deviceUid,
            });
          }
          log(`--- [${room.label}] cleaned up`);
        } catch (err) {
          log(`--- [${room.label}] cleanup failed: ${err.message}`);
        }
      }
    }
  }

  // ---- Report ----
  const failures = [];
  for (const room of rooms) {
    for (const check of room.checks ?? []) {
      if (!check.ok) failures.push(`room ${room.label}: ${check.name}`);
    }
  }
  if (rooms.some((r) => !r.checks)) {
    failures.push('the run ended before every room was evaluated');
  }

  const result = {
    ok: failures.length === 0,
    capacityRefusal,
    rooms: rooms.map((r) => ({
      label: r.label,
      kind: r.kind,
      roomUid: r.roomUid,
      deviceUid: r.device?.deviceUid ?? null,
      sessionUid: r.session?.uid ?? null,
      joinCode: r.joinCode ?? null,
      viewerUrl: r.viewerUrl ?? null,
      framesSent: r.framesSent ?? 0,
      statusTrail: r.statusTrail ?? '',
      transcript: r.transcript ?? '',
      sourceErrors: r.sourceErrors ?? [],
      checks: r.checks ?? [],
    })),
    failures,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\n=== RESULT ===');
    for (const room of result.rooms) {
      console.log(`\nroom ${room.label} (${room.kind}) — ${room.roomUid}`);
      console.log(`  status trail : ${room.statusTrail || '(none)'}`);
      console.log(`  frames sent  : ${room.framesSent}`);
      if (room.transcript) {
        console.log(`  transcript   : "${room.transcript.slice(0, 160)}"`);
      }
      for (const check of room.checks) {
        console.log(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name}`);
        console.log(`         ${check.detail}`);
      }
    }
    if (capacityRefusal) {
      console.log(
        '\nCAPACITY REFUSAL: the transcription service refused admission for at\n' +
          'least one room (close 1013 / sessionStatus at-capacity). This is a\n' +
          'deployment ceiling, not a defect in the session machinery. The shipped\n' +
          'provider_config.json runs num_workers=1, and the per-worker admission\n' +
          'estimate is dynamic: it starts low on a cold process and ratchets up as\n' +
          'measured per-session cost arrives, so a run right after a restart can be\n' +
          'refused where the same run minutes later is not. Read the live value from\n' +
          "the service's /providers/health (needs TRANSCRIPTION_METRICS_KEY), then\n" +
          're-run with fewer --rooms or raise the ceiling.',
      );
    }
    console.log(result.ok ? '\nPASS' : `\nFAIL\n - ${failures.join('\n - ')}`);
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(2);
});
