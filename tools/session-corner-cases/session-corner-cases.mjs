/**
 * Adversarial corner-case regression suite for sessions, scheduling and the
 * calendar.
 *
 * Usage:
 *   node tools/session-corner-cases/session-corner-cases.mjs [options]
 *
 * Options:
 *   --base-url <url>   default https://localhost (self-signed certs accepted)
 *   --env-file <path>  where to read SESSION_MANAGER_API_KEY from. Defaults to
 *                      <repo>/deployment/.env then <repo>/../deployment/.env.
 *   --only <substr>    run only checks whose name contains <substr> (repeatable)
 *   --list             print the check names and exit
 *   --quick            skip the two wall-clock checks (~6 min of waiting)
 *   --no-stream        skip the one check that streams audio
 *   --keep             leave provisioned rooms/devices in place
 *   --json             machine-readable result on stdout
 *
 * Why this exists, and why it is shaped like this:
 *
 * The session/schedule machinery is where this repo's shipped bugs have
 * clustered - `1bfbc60` (tokens for canceled sessions), `f7b26b6` (join codes
 * exchangeable before `valid_start`), `16e07c9` (unknown provider accepted at
 * write time), `bc37f92` (source-free sessions never told viewers they ended).
 * Every one of them was invisible to the unit and integration suites and needed
 * a *live* room, a real clock, and an adversarial input to surface. That is what
 * this is: one process, real HTTP and real WebSockets against a running stack,
 * with each assertion named for the behaviour it pins.
 *
 * Three conventions matter when reading the output:
 *
 *   PASS            the behaviour is what it should be.
 *   PASS (pins ...) the behaviour is what it *currently is*, and that is
 *                   questionable or outright wrong. The assertion encodes the
 *                   real behaviour deliberately, so the suite stays green and a
 *                   *fix* fails here loudly and forces the assertion to be
 *                   updated alongside it. Every one of these is listed in the
 *                   README with its reproduction.
 *   FAIL            a regression.
 *
 * The alternative - asserting the desired behaviour and shipping a permanently
 * red suite - makes a real regression indistinguishable from the known
 * backlog, which is how a red suite stops being read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TRANSCRIPTION_STREAM_CLIENT_ROUTE,
  TranscriptionServiceDisconnectReason,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import {
  CANARY_DEVICE_UID,
  CANARY_ROOM_UID,
  DEMO_ROOM_UID,
  DEMO_SOURCE_DEVICE_UID,
  DEVICE_TOKEN_COOKIE_NAME,
} from '@scribear/session-manager-schema';
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

// The stack under test terminates TLS with a self-signed certificate. Set here
// rather than in the shell so a bare `npm run e2e:sessions` works; nothing has
// opened a socket at this point.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const WAV = join(
  REPO_ROOT,
  'test_audio_files',
  'speech',
  'harvard_16k_mono.wav',
);

/** Matches the kiosk's `AUDIO_CHUNK_MS`, so frames look like a kiosk's. */
const CHUNK_MS = 100;

const ALL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back an auto-session window's `activeStart` is placed by default.
 *
 * No longer required to get a session covering *now* - `inRange` clips an
 * occurrence to `activeStart` rather than dropping it, so a window created at
 * 16:00 with `activeStart = now` covers the rest of today (asserted by
 * `an-auto-window-starting-now-covers-the-rest-of-today`). It is kept because
 * several checks want a window that has been active for a while, so the AUTO
 * session's `effectiveStart` is in the past: that is what exercises the
 * reconciler's preserve-the-running-AUTO branch rather than its
 * create-a-fresh-slot one.
 */
const BACKDATE_MS = 7 * DAY_MS;

/** Provider key every deployment in this repo configures. */
const PROVIDER = 'whisper';

/** Session end must reach a viewer well inside this. */
const SESSION_END_DEADLINE_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    baseUrl: 'https://localhost',
    envFile: '',
    only: [],
    list: false,
    quick: false,
    stream: true,
    keep: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--list') args.list = true;
    else if (flag === '--quick') args.quick = true;
    else if (flag === '--no-stream') args.stream = false;
    else if (flag === '--keep') args.keep = true;
    else if (flag === '--base-url') args.baseUrl = argv[++i];
    else if (flag === '--env-file') args.envFile = argv[++i];
    else if (flag === '--only') args.only.push(argv[++i]);
    else throw new Error(`Unknown option ${flag}`);
  }
  return args;
}

/**
 * Read the deployment env for the admin key. A plain scan rather than a dotenv
 * dependency, matching `tools/demo-e2e` and `tools/e2e-audio`. The search order
 * matters on a box where the running stack lives outside the repo.
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

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/**
 * Session-manager client that never throws on a non-2xx: every check here is
 * *about* the status code, so an exception would throw away the thing under
 * test.
 */
function createApi(baseUrl, adminKey) {
  const root = `${baseUrl}/api/session-manager/v1`;

  async function req(method, path, { body, admin, deviceToken } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (admin) headers.authorization = `Bearer ${adminKey}`;
    if (deviceToken) {
      headers.cookie = `${DEVICE_TOKEN_COOKIE_NAME}=${encodeURIComponent(deviceToken)}`;
    }
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
    return { status: res.status, body: parsed, headers: res.headers };
  }

  return {
    /** Admin-key routes. */
    post: (path, body) => req('POST', path, { body, admin: true }),
    get: (path) => req('GET', path, { admin: true }),
    /** Routes where a join code / activation code is itself the credential. */
    anon: (path, body) => req('POST', path, { body }),
    /** Device-token routes. */
    device: (deviceToken, path, body) =>
      req('POST', path, { body, deviceToken }),
  };
}

// ---------------------------------------------------------------------------
// Assertion recorder
// ---------------------------------------------------------------------------

class Recorder {
  constructor(checkName) {
    this.checkName = checkName;
    this.assertions = [];
  }

  /** A plain assertion: it passes when the behaviour is what it should be. */
  ok(name, condition, detail) {
    this.assertions.push({ name, ok: Boolean(condition), detail, pins: null });
    return Boolean(condition);
  }

  /**
   * An assertion that encodes the behaviour the stack *currently* has, where
   * that behaviour is questionable or wrong. Passing means "still broken the
   * same way"; failing means somebody changed it and must update this line.
   */
  pin(name, condition, detail, pins) {
    this.assertions.push({ name, ok: Boolean(condition), detail, pins });
    return Boolean(condition);
  }

  /** Convenience for the overwhelmingly common "status (and code) is X" shape. */
  status(name, res, expectedStatus, expectedCode) {
    const codeOk =
      expectedCode === undefined || res.body?.code === expectedCode;
    return this.ok(
      name,
      res.status === expectedStatus && codeOk,
      `got ${res.status}${res.body?.code ? ` ${res.body.code}` : ''}` +
        `, wanted ${expectedStatus}${expectedCode ? ` ${expectedCode}` : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Tracks everything a run created so teardown can remove it, and names it
 * distinctively so an orphan left by a crashed run is identifiable at a glance.
 */
class Fixtures {
  constructor(api, stamp) {
    this.api = api;
    this.stamp = stamp;
    this.rooms = [];
    this.devices = [];
  }

  name(label) {
    return `${this.stamp}-${label}`;
  }

  /**
   * Register a device and immediately activate it. The two calls are adjacent
   * on purpose: an activation code is single-use and expires five minutes after
   * registration, so anything that separates them turns a rerun into a dead
   * device. The 64-byte secret is only ever revealed in a `Set-Cookie` header,
   * which is why this reads `getSetCookie()` rather than the JSON body.
   */
  async device(label) {
    const reg = await this.api.post('device-management/register-device', {
      name: this.name(label),
    });
    if (reg.status !== 201 && reg.status !== 200) {
      throw new Error(
        `register-device -> ${reg.status} ${JSON.stringify(reg.body)}`,
      );
    }
    this.devices.push(reg.body.deviceUid);

    const act = await this.api.anon('device-management/activate-device', {
      activationCode: reg.body.activationCode,
    });
    const prefix = `${DEVICE_TOKEN_COOKIE_NAME}=`;
    const cookie = (act.headers.getSetCookie() ?? []).find((c) =>
      c.startsWith(prefix),
    );
    if (!cookie) {
      throw new Error(
        `activate-device set no ${DEVICE_TOKEN_COOKIE_NAME} cookie (${act.status})`,
      );
    }
    return {
      deviceUid: reg.body.deviceUid,
      activationCode: reg.body.activationCode,
      expiry: reg.body.expiry,
      deviceToken: decodeURIComponent(
        cookie.slice(prefix.length).split(';')[0],
      ),
    };
  }

  /** A room with exactly one activated source device. */
  async room(label, { timezone = 'UTC', auto = false } = {}) {
    const device = await this.device(`${label}-src`);
    const res = await this.api.post('room-management/create-room', {
      name: this.name(label),
      timezone,
      autoSessionEnabled: auto,
      sourceDeviceUids: [device.deviceUid],
    });
    if (res.status !== 201) {
      throw new Error(
        `create-room -> ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    this.rooms.push(res.body.uid);
    return { roomUid: res.body.uid, device, timezone };
  }

  onDemand(roomUid, name, overrides = {}) {
    return this.api.post('schedule-management/create-on-demand-session', {
      roomUid,
      name: this.name(name),
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
      transcriptionProviderId: PROVIDER,
      transcriptionStreamConfig: {},
      ...overrides,
    });
  }

  /** A daily auto-session window covering the whole local day. */
  window(roomUid, overrides = {}) {
    return this.api.post('schedule-management/create-auto-session-window', {
      roomUid,
      localStartTime: '00:00',
      localEndTime: '23:59',
      daysOfWeek: ALL_DAYS,
      activeStart: new Date(Date.now() - BACKDATE_MS).toISOString(),
      activeEnd: null,
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
      transcriptionProviderId: PROVIDER,
      transcriptionStreamConfig: {},
      ...overrides,
    });
  }

  schedule(roomUid, overrides = {}) {
    return this.api.post('schedule-management/create-schedule', {
      roomUid,
      name: this.name('sched'),
      activeStart: new Date(Date.now() + 5_000).toISOString(),
      activeEnd: null,
      localStartTime: '09:00',
      localEndTime: '10:00',
      frequency: 'WEEKLY',
      daysOfWeek: ALL_DAYS,
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
      transcriptionProviderId: PROVIDER,
      transcriptionStreamConfig: {},
      ...overrides,
    });
  }

  async activeSession(roomUid, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.api.get(
        `schedule-management/get-active-session/${roomUid}`,
      );
      if (res.body) return res.body;
      if (Date.now() > deadline) return null;
      await sleep(400);
    }
  }

  async listSessions(roomUid, fromMs = -60_000, toMs = DAY_MS) {
    const from = new Date(Date.now() + fromMs).toISOString();
    const to = new Date(Date.now() + toMs).toISOString();
    const res = await this.api.get(
      `schedule-management/list-sessions?roomUids=${roomUid}` +
        `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    return res.body?.items ?? [];
  }

  async teardown(log) {
    for (const roomUid of this.rooms) {
      // Room first: it cascades sessions, windows, schedules and memberships,
      // and a device cannot be deleted while it is still its room's source.
      const res = await this.api.post('room-management/delete-room', {
        roomUid,
      });
      if (res.status !== 204 && res.status !== 404) {
        log(`  ! delete-room ${roomUid} -> ${res.status}`);
      }
    }
    for (const deviceUid of this.devices) {
      const res = await this.api.post('device-management/delete-device', {
        deviceUid,
      });
      if (res.status !== 204 && res.status !== 404) {
        log(`  ! delete-device ${deviceUid} -> ${res.status}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** `HH:MM:SS` of a Date read in UTC - for rooms whose timezone is UTC. */
function utcHms(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}

/** Zone offset in minutes at `date`, from the host ICU database. */
function offsetMinutes(zone, date) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * The next `count` UTC instants at which `zone` changes offset, found by a
 * six-hour scan with a binary search inside the bracketing step.
 *
 * Computed rather than hardcoded so the DST checks keep working after the dates
 * they were written against have passed - a hardcoded 2027-03-14 becomes an
 * `INVALID_ACTIVE_START` the moment it is in the past, which is exactly the
 * kind of rot that makes a suite get deleted instead of fixed.
 */
function nextTransitions(zone, from, count) {
  const found = [];
  const step = 6 * 60 * 60 * 1000;
  const limit = from.getTime() + 800 * DAY_MS;
  let t = from.getTime();
  let prev = offsetMinutes(zone, new Date(t));
  while (t < limit && found.length < count) {
    const next = t + step;
    const off = offsetMinutes(zone, new Date(next));
    if (off !== prev) {
      let lo = t;
      let hi = next;
      while (hi - lo > 1000) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetMinutes(zone, new Date(mid)) === prev) lo = mid;
        else hi = mid;
      }
      found.push({ at: new Date(hi), fromOffset: prev, toOffset: off });
      prev = off;
    }
    t = next;
  }
  return found;
}

/** The three-letter `DayOfWeek` a UTC instant falls on in `zone`. */
function localDayOfWeek(zone, date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' })
    .format(date)
    .toUpperCase()
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

/**
 * Open a viewer socket exactly as a browser viewer does: exchange the join code
 * (unauthenticated - the code *is* the credential), then speak the client
 * route. Deliberately not the source token's own receive scope, which would
 * skip `/client` and the fan-out path entirely.
 */
async function openViewer(api, baseUrl, joinCode) {
  const exchanged = await api.anon('session-auth/exchange-join-code', {
    joinCode,
  });
  if (exchanged.status !== 200) {
    throw new Error(
      `exchange-join-code -> ${exchanged.status} ${JSON.stringify(exchanged.body)}`,
    );
  }

  const observed = {
    authOk: false,
    statuses: [],
    ended: false,
    endedAtMs: null,
    closes: [],
    atCapacity: false,
  };

  const socket = connectStreamSocket(
    baseUrl,
    TRANSCRIPTION_STREAM_CLIENT_ROUTE,
    exchanged.body.sessionUid,
    exchanged.body.sessionToken,
  );

  // Registered synchronously, before the socket can have opened, so no early
  // message is missed.
  socket.on('message', (msg) => {
    if (msg.type === TranscriptionStreamServerMessageType.AUTH_OK) {
      observed.authOk = true;
    } else if (
      msg.type === TranscriptionStreamServerMessageType.SESSION_STATUS
    ) {
      observed.statuses.push({
        source: msg.sourceDeviceConnected,
        service: msg.transcriptionServiceConnected,
      });
      if (
        msg.transcriptionServiceDisconnectReason ===
        TranscriptionServiceDisconnectReason.AT_CAPACITY
      ) {
        observed.atCapacity = true;
      }
    } else if (
      msg.type === TranscriptionStreamServerMessageType.SESSION_ENDED
    ) {
      observed.ended = true;
      observed.endedAtMs = Date.now();
    }
  });
  socket.on('close', (code, reason) => {
    observed.closes.push({ code, reason });
    // 1013 is the transcription service refusing admission, relayed down.
    if (code === 1013) observed.atCapacity = true;
  });
  socket.on('error', () => {
    // Recorded through `closes`; an unhandled 'error' would kill the process.
  });

  await waitForSocketOpen(socket, 15_000);
  return { socket, observed, exchanged: exchanged.body };
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

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Each entry pins one behaviour. `name` is the behaviour, not the mechanism, so
 * a failure line reads as a statement about the product.
 *
 * `tags`:
 *   'slow'   - waits on the wall clock; skipped by --quick.
 *   'stream' - opens a source socket and costs transcription capacity;
 *              skipped by --no-stream.
 */
const CHECKS = [
  // -- session lifecycle ---------------------------------------------------
  {
    group: 'session lifecycle',
    name: 'a-second-on-demand-session-in-a-live-room-is-refused',
    async run(t, { fx }) {
      const room = await fx.room('sec-od');
      const first = await fx.onDemand(room.roomUid, 'first');
      t.status('the first on-demand session is created', first, 201);

      const second = await fx.onDemand(room.roomUid, 'second');
      t.status(
        'a second on-demand session is refused 409 ANOTHER_SESSION_ACTIVE',
        second,
        409,
        'ANOTHER_SESSION_ACTIVE',
      );

      // The room row is locked for the whole transaction, so concurrency must
      // not open a second door: five simultaneous creates must leave one
      // session, not five. A lost race here would put two open-ended ON_DEMAND
      // rows in one room, which the sessions_no_overlap constraint is supposed
      // to make impossible.
      const race = await fx.room('sec-od-race');
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          fx.onDemand(race.roomUid, `race-${i}`),
        ),
      );
      const created = results.filter((r) => r.status === 201);
      const refused = results.filter(
        (r) => r.status === 409 && r.body?.code === 'ANOTHER_SESSION_ACTIVE',
      );
      t.ok(
        'five simultaneous on-demand creates produce exactly one session',
        created.length === 1 && refused.length === 4,
        `statuses ${results.map((r) => r.status).join(',')}`,
      );
      const live = await fx.listSessions(race.roomUid);
      t.ok(
        'and the room holds exactly one session afterwards',
        live.length === 1,
        `${live.length} session(s): ${live.map((s) => s.name).join(', ')}`,
      );
    },
  },

  {
    group: 'session lifecycle',
    name: 'an-on-demand-session-preempts-the-live-auto-session',
    async run(t, { fx, api }) {
      const room = await fx.room('preempt', { auto: true });
      await fx.window(room.roomUid);
      const auto = await fx.activeSession(room.roomUid);
      t.ok(
        'a room with an auto window covering now has a live AUTO session',
        auto?.type === 'AUTO',
        `active session type ${auto?.type ?? 'none'}`,
      );

      const od = await fx.onDemand(room.roomUid, 'preemptor');
      t.status(
        'an on-demand session is accepted even though an AUTO one is live',
        od,
        201,
      );

      const after = await api.get(
        `schedule-management/get-session/${auto.uid}`,
      );
      t.ok(
        'the preempted AUTO session has end_override set',
        after.body?.endOverride !== null &&
          after.body?.effectiveEnd === after.body?.endOverride,
        `endOverride=${after.body?.endOverride} effectiveEnd=${after.body?.effectiveEnd}`,
      );
      t.ok(
        'the AUTO session really ended (its end is at or before now)',
        Date.parse(after.body.effectiveEnd) <= Date.now(),
        `effectiveEnd ${after.body.effectiveEnd} vs now ${new Date().toISOString()}`,
      );

      const live = await api.get(
        `schedule-management/get-active-session/${room.roomUid}`,
      );
      t.ok(
        'the on-demand session is now the room’s active session',
        live.body?.uid === od.body.uid && live.body?.type === 'ON_DEMAND',
        `active is ${live.body?.type} ${live.body?.uid}`,
      );
    },
  },

  {
    group: 'session lifecycle',
    name: 'ending-a-session-early-tells-a-viewer-with-no-source-attached',
    async run(t, { fx, api, baseUrl }) {
      // The regression bc37f92 fixed: registerSource was the only thing that
      // ever armed the session-end timer, so a room whose viewers joined
      // *without* a kiosk had nobody watching the clock and sat on stale
      // captions for up to half a token lifetime.
      const room = await fx.room('endwatch');
      const session = await fx.onDemand(room.roomUid, 'endwatch');
      const code = await api.post('session-auth/admin-fetch-join-code', {
        sessionUid: session.body.uid,
      });
      t.ok(
        'a live on-demand session mints a join code',
        code.body?.status === 'ok',
        `status ${code.body?.status}`,
      );

      const viewer = await openViewer(api, baseUrl, code.body.joinCode);
      t.ok('the viewer socket authenticates', viewer.observed.authOk, '');
      await sleep(1000);
      t.ok(
        'no source is attached (the first status has both flags false)',
        viewer.observed.statuses[0]?.source === false &&
          viewer.observed.statuses[0]?.service === false,
        JSON.stringify(viewer.observed.statuses[0] ?? null),
      );

      const t0 = Date.now();
      const ended = await api.post('schedule-management/end-session-early', {
        sessionUid: session.body.uid,
      });
      t.status('end-session-early succeeds', ended, 200);

      const deadline = Date.now() + SESSION_END_DEADLINE_MS;
      while (
        Date.now() < deadline &&
        !(viewer.observed.ended && viewer.observed.closes.length > 0)
      ) {
        await sleep(100);
      }
      t.ok(
        'the source-free viewer receives sessionEnded',
        viewer.observed.ended,
        viewer.observed.ended
          ? `after ${viewer.observed.endedAtMs - t0}ms`
          : `nothing within ${SESSION_END_DEADLINE_MS}ms`,
      );
      t.ok(
        'and its socket is closed 1000',
        viewer.observed.closes.some((c) => c.code === 1000),
        JSON.stringify(viewer.observed.closes),
      );
      try {
        viewer.socket.terminate(1000, 'check-complete');
      } catch {
        // already gone
      }
    },
  },

  {
    group: 'session lifecycle',
    tags: ['stream'],
    name: 'ending-a-session-early-tells-a-viewer-while-a-source-is-streaming',
    async run(t, { fx, api, baseUrl, chunks }) {
      // The other half of bc37f92: with a live SessionState the *source* path
      // owns the end timer, and the two owners must not cancel each other out.
      const room = await fx.room('endstream');
      const session = await fx.onDemand(room.roomUid, 'endstream');
      const code = await api.post('session-auth/admin-fetch-join-code', {
        sessionUid: session.body.uid,
      });
      const viewer = await openViewer(api, baseUrl, code.body.joinCode);

      const auth = new DeviceAuthClient({
        sessionManagerBaseUrl: baseUrl,
        deviceToken: room.device.deviceToken,
        timeoutMs: 10_000,
      });
      const stream = new TestAudioStream(
        { nodeServerBaseUrl: baseUrl, upstreamWaitMs: 20_000 },
        auth,
        new GoodEngine(GOOD_PARAM_DEFAULTS, createSeededRng(7)),
        quietLogger(),
      );
      const done = stream
        .run(chunks, Date.now() + 30_000)
        .catch((err) => ({ error: err }));

      // Wait for the source to actually register, not a fixed sleep: the
      // assertion is about ending a session mid-stream, so a run where the
      // source never arrived would be asserting nothing.
      const registerBy = Date.now() + 20_000;
      while (
        Date.now() < registerBy &&
        !viewer.observed.statuses.some((s) => s.source) &&
        !viewer.observed.atCapacity
      ) {
        await sleep(200);
      }

      if (viewer.observed.atCapacity) {
        stream.stop();
        await done;
        try {
          viewer.socket.terminate(1000, 'at-capacity');
        } catch {
          // already gone
        }
        return {
          skipped:
            'the transcription service refused admission (at-capacity). ' +
            'This is a deployment ceiling, not a session-machinery defect; ' +
            're-run later or with --no-stream.',
        };
      }

      t.ok(
        'the viewer sees the source connect',
        viewer.observed.statuses.some((s) => s.source),
        JSON.stringify(viewer.observed.statuses),
      );

      // Let real audio frames reach the wire before ending. "Mid-stream" has to
      // mean mid-stream: registering and immediately ending would exercise the
      // teardown path with an idle upstream, which is not the case that broke.
      const streamBy = Date.now() + 5_000;
      while (Date.now() < streamBy && stream.counters.framesSent < 20) {
        await sleep(200);
      }
      t.ok(
        'audio frames are actually on the wire when the session is ended',
        stream.counters.framesSent > 0,
        `${stream.counters.framesSent} frame(s) sent`,
      );

      const t0 = Date.now();
      const ended = await api.post('schedule-management/end-session-early', {
        sessionUid: session.body.uid,
      });
      t.status('end-session-early succeeds mid-stream', ended, 200);

      const deadline = Date.now() + SESSION_END_DEADLINE_MS;
      while (
        Date.now() < deadline &&
        !(viewer.observed.ended && viewer.observed.closes.length > 0)
      ) {
        await sleep(100);
      }
      t.ok(
        'the viewer receives sessionEnded while a source is mid-stream',
        viewer.observed.ended,
        viewer.observed.ended
          ? `after ${viewer.observed.endedAtMs - t0}ms`
          : `nothing within ${SESSION_END_DEADLINE_MS}ms`,
      );
      t.ok(
        'and its socket is closed 1000',
        viewer.observed.closes.some((c) => c.code === 1000),
        JSON.stringify(viewer.observed.closes),
      );

      stream.stop();
      const result = await done;
      const reconnect = await api.device(
        room.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.body.uid },
      );
      t.status(
        'and the source cannot mint a fresh token to reconnect into the dead session',
        reconnect,
        409,
        'SESSION_NOT_CURRENTLY_ACTIVE',
      );
      t.ok(
        'the streaming run ends rather than hanging',
        result !== undefined,
        `frames sent ${stream.counters.framesSent}` +
          (result?.error ? `, last error ${result.error}` : ''),
      );
      try {
        viewer.socket.terminate(1000, 'check-complete');
      } catch {
        // already gone
      }
    },
  },

  {
    group: 'session lifecycle',
    name: 'starting-a-session-early-moves-its-effective-start-and-makes-it-joinable',
    async run(t, { fx, api }) {
      const room = await fx.room('startearly');
      const startsAt = new Date(Date.now() + 120_000);
      await fx.schedule(room.roomUid, {
        frequency: 'ONCE',
        daysOfWeek: null,
        localStartTime: utcHms(startsAt),
        localEndTime: utcHms(new Date(startsAt.getTime() + 10 * 60_000)),
      });
      const [session] = await fx.listSessions(room.roomUid);
      t.ok(
        'a ONCE schedule materializes exactly one upcoming session',
        session?.type === 'SCHEDULED',
        `${session?.type ?? 'none'} at ${session?.effectiveStart}`,
      );

      const before = await api.post('session-auth/admin-fetch-join-code', {
        sessionUid: session.uid,
      });
      t.ok(
        'an upcoming session cannot mint a join code yet',
        before.body?.status === 'not-active',
        `status ${before.body?.status}`,
      );

      const early = await api.post('schedule-management/start-session-early', {
        sessionUid: session.uid,
      });
      t.status('start-session-early succeeds', early, 200);
      t.ok(
        'effectiveStart moves back to the start_override',
        early.body?.startOverride !== null &&
          early.body?.effectiveStart === early.body?.startOverride &&
          Date.parse(early.body.effectiveStart) <
            Date.parse(session.effectiveStart),
        `${session.effectiveStart} -> ${early.body?.effectiveStart}`,
      );

      const after = await api.post('session-auth/admin-fetch-join-code', {
        sessionUid: session.uid,
      });
      t.ok(
        'the session becomes joinable immediately',
        after.body?.status === 'ok' && typeof after.body?.joinCode === 'string',
        `status ${after.body?.status}`,
      );

      const token = await api.device(
        room.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.uid },
      );
      t.ok(
        'and the room’s source device gets SEND_AUDIO for it',
        token.status === 200 && token.body?.scopes?.includes('SEND_AUDIO'),
        `${token.status} scopes=${JSON.stringify(token.body?.scopes)}`,
      );
    },
  },

  {
    group: 'session lifecycle',
    tags: ['slow'],
    name: 'canceling-a-session-is-terminal-once-its-slot-arrives',
    async run(t, { fx, api }) {
      // The regression 1bfbc60 fixed. cancel-session accepts only *upcoming*
      // occurrences, so the interesting moment is the one time catches up to:
      // a canceled row whose start/end window now contains `now`. Before the
      // fix every session-auth predicate read start/end only and happily
      // minted credentials - including SEND_AUDIO to the room's kiosk - for a
      // session an operator had canceled.
      const room = await fx.room('cancelterm');
      const startsAt = new Date(Date.now() + 45_000);
      await fx.schedule(room.roomUid, {
        frequency: 'ONCE',
        daysOfWeek: null,
        localStartTime: utcHms(startsAt),
        localEndTime: utcHms(new Date(startsAt.getTime() + 10 * 60_000)),
      });
      const [session] = await fx.listSessions(room.roomUid);
      t.ok(
        'the occurrence materialized',
        session?.type === 'SCHEDULED',
        `${session?.type ?? 'none'}`,
      );

      const canceled = await api.post('schedule-management/cancel-session', {
        sessionUid: session.uid,
      });
      t.status(
        'cancel-session succeeds while it is still upcoming',
        canceled,
        200,
      );
      t.ok(
        'canceled_at is stamped',
        canceled.body?.canceledAt !== null,
        `${canceled.body?.canceledAt}`,
      );

      const waitMs = Date.parse(session.effectiveStart) - Date.now() + 3_000;
      await sleep(Math.max(0, waitMs));
      t.ok(
        'the canceled slot is now in the past (its window contains now)',
        Date.now() > Date.parse(session.effectiveStart),
        `start ${session.effectiveStart}`,
      );

      const admin = await api.post('session-auth/admin-fetch-join-code', {
        sessionUid: session.uid,
      });
      t.ok(
        'admin-fetch-join-code reports not-active for a canceled session',
        admin.body?.status === 'not-active',
        `status ${admin.body?.status}`,
      );

      const deviceCode = await api.device(
        room.device.deviceToken,
        'session-auth/fetch-join-code',
        { sessionUid: session.uid },
      );
      t.status(
        'the device-facing join-code route reports a canceled session as gone',
        deviceCode,
        404,
        'SESSION_NOT_FOUND',
      );

      const deviceToken = await api.device(
        room.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.uid },
      );
      t.status(
        'exchange-device-token refuses a canceled session',
        deviceToken,
        409,
        'SESSION_NOT_CURRENTLY_ACTIVE',
      );

      const live = await api.get(
        `schedule-management/get-active-session/${room.roomUid}`,
      );
      t.ok(
        'and the room reports no active session at all',
        live.body === null,
        JSON.stringify(live.body),
      );
    },
  },

  {
    group: 'session lifecycle',
    name: 'uncanceling-restores-an-occurrence-unless-an-auto-session-took-the-slot',
    async run(t, { fx, api }) {
      const plain = await fx.room('uncancel');
      const startsAt = new Date(Date.now() + 180_000);
      await fx.schedule(plain.roomUid, {
        frequency: 'ONCE',
        daysOfWeek: null,
        localStartTime: utcHms(startsAt),
        localEndTime: utcHms(new Date(startsAt.getTime() + 10 * 60_000)),
      });
      const [session] = await fx.listSessions(plain.roomUid);
      await api.post('schedule-management/cancel-session', {
        sessionUid: session.uid,
      });
      const restored = await api.post('schedule-management/uncancel-session', {
        sessionUid: session.uid,
      });
      t.status('uncancel-session restores a free slot', restored, 200);
      t.ok(
        'and clears canceled_at',
        restored.body?.canceledAt === null,
        `${restored.body?.canceledAt}`,
      );
      const again = await api.post('schedule-management/uncancel-session', {
        sessionUid: session.uid,
      });
      t.status(
        'uncanceling a session that is not canceled is 422',
        again,
        422,
        'SESSION_NOT_CANCELED',
      );

      // In an auto-enabled room the reconciler backfills the freed slot the
      // instant it is freed, so the undo has nowhere to land.
      const auto = await fx.room('uncancel-auto', { auto: true });
      await fx.window(auto.roomUid);
      await fx.schedule(auto.roomUid, {
        frequency: 'ONCE',
        daysOfWeek: null,
        localStartTime: utcHms(startsAt),
        localEndTime: utcHms(new Date(startsAt.getTime() + 10 * 60_000)),
      });
      const inAuto = (await fx.listSessions(auto.roomUid)).find(
        (s) => s.type === 'SCHEDULED',
      );
      t.ok(
        'the occurrence materializes between two AUTO sessions',
        Boolean(inAuto),
        `types: ${(await fx.listSessions(auto.roomUid)).map((s) => s.type).join(',')}`,
      );
      await api.post('schedule-management/cancel-session', {
        sessionUid: inAuto.uid,
      });
      const merged = await fx.listSessions(auto.roomUid);
      const covering = merged.find(
        (s) =>
          s.type === 'AUTO' &&
          !s.canceledAt &&
          Date.parse(s.effectiveStart) <= Date.parse(inAuto.effectiveStart) &&
          Date.parse(s.effectiveEnd) >= Date.parse(inAuto.effectiveEnd),
      );
      t.ok(
        'canceling it lets an AUTO session backfill the freed slot',
        Boolean(covering),
        `sessions now: ${merged
          .map(
            (s) =>
              `${s.type}${s.canceledAt ? '(canceled)' : ''} ${s.effectiveStart}..${s.effectiveEnd}`,
          )
          .join(' | ')}`,
      );
      const blocked = await api.post('schedule-management/uncancel-session', {
        sessionUid: inAuto.uid,
      });
      t.status(
        'and the undo is refused because the slot is no longer free',
        blocked,
        409,
        'SLOT_NO_LONGER_AVAILABLE',
      );
    },
  },

  {
    group: 'session lifecycle',
    name: 'an-ended-session-refuses-its-old-join-code-and-its-refresh-token',
    async run(t, { fx, api }) {
      const room = await fx.room('ended-auth');
      const session = await fx.onDemand(room.roomUid, 'ended-auth');
      const code = await api.post('session-auth/admin-fetch-join-code', {
        sessionUid: session.body.uid,
      });
      const exchanged = await api.anon('session-auth/exchange-join-code', {
        joinCode: code.body.joinCode,
      });
      t.status('a live session exchanges its join code', exchanged, 200);

      const refreshedWhileLive = await api.anon(
        'session-auth/refresh-session-token',
        { sessionRefreshToken: exchanged.body.sessionRefreshToken },
      );
      t.status(
        'and the refresh token works while it is live',
        refreshedWhileLive,
        200,
      );

      await api.post('schedule-management/end-session-early', {
        sessionUid: session.body.uid,
      });

      const rejoin = await api.anon('session-auth/exchange-join-code', {
        joinCode: code.body.joinCode,
      });
      t.status(
        're-joining an ended session with the old code is 409 SESSION_NOT_CURRENTLY_ACTIVE',
        rejoin,
        409,
        'SESSION_NOT_CURRENTLY_ACTIVE',
      );

      const refreshed = await api.anon('session-auth/refresh-session-token', {
        sessionRefreshToken: exchanged.body.sessionRefreshToken,
      });
      t.status(
        'and the refresh token stops minting across the session end',
        refreshed,
        409,
        'SESSION_ENDED',
      );

      const deviceToken = await api.device(
        room.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.body.uid },
      );
      t.status(
        'the source device is refused a token for the ended session too',
        deviceToken,
        409,
        'SESSION_NOT_CURRENTLY_ACTIVE',
      );
    },
  },

  {
    group: 'session lifecycle',
    name: 'only-upcoming-scheduled-sessions-cancel-and-only-live-non-auto-ones-end',
    async run(t, { fx, api }) {
      const auto = await fx.room('verbs-auto', { auto: true });
      await fx.window(auto.roomUid);
      const live = await fx.activeSession(auto.roomUid);

      const endAuto = await api.post('schedule-management/end-session-early', {
        sessionUid: live.uid,
      });
      t.status(
        'an AUTO session cannot be ended early',
        endAuto,
        422,
        'SESSION_IS_AUTO',
      );
      const startAuto = await api.post(
        'schedule-management/start-session-early',
        { sessionUid: live.uid },
      );
      t.status(
        'an AUTO session cannot be started early',
        startAuto,
        422,
        'SESSION_IS_AUTO',
      );
      const cancelAuto = await api.post('schedule-management/cancel-session', {
        sessionUid: live.uid,
      });
      t.status(
        'an AUTO session cannot be canceled',
        cancelAuto,
        422,
        'SESSION_NOT_SCHEDULED_TYPE',
      );

      const plain = await fx.room('verbs-od');
      const od = await fx.onDemand(plain.roomUid, 'verbs');
      const cancelOd = await api.post('schedule-management/cancel-session', {
        sessionUid: od.body.uid,
      });
      t.status(
        'an ON_DEMAND session cannot be canceled',
        cancelOd,
        422,
        'SESSION_NOT_SCHEDULED_TYPE',
      );
      const first = await api.post('schedule-management/end-session-early', {
        sessionUid: od.body.uid,
      });
      t.status('ending a live on-demand session succeeds', first, 200);
      const second = await api.post('schedule-management/end-session-early', {
        sessionUid: od.body.uid,
      });
      t.status(
        'ending it a second time is 422 SESSION_NOT_ACTIVE',
        second,
        422,
        'SESSION_NOT_ACTIVE',
      );
    },
  },

  {
    group: 'session lifecycle',
    name: 'an-auto-enabled-room-survives-repeated-on-demand-start-stop-churn',
    async run(t, { fx, api }) {
      // CONTRIBUTING's "a feature with a 'currently active' notion needs a
      // fixture that is active now": a 500 that broke every on-demand session
      // in every auto-enabled room survived 341 integration tests because no
      // fixture was live. Two full cycles exercise create -> preempt ->
      // end -> backfill -> create again, each of which reconciles AUTO rows
      // against a deferred exclusion constraint.
      const room = await fx.room('churn', { auto: true });
      await fx.window(room.roomUid);
      for (let cycle = 1; cycle <= 2; cycle++) {
        const before = await fx.activeSession(room.roomUid);
        t.ok(
          `cycle ${cycle}: an AUTO session holds the room before the on-demand one`,
          before?.type === 'AUTO',
          `active ${before?.type ?? 'none'}`,
        );
        const od = await fx.onDemand(room.roomUid, `churn-${cycle}`);
        t.status(
          `cycle ${cycle}: creating an on-demand session in a live auto room succeeds`,
          od,
          201,
        );
        const ended = await api.post('schedule-management/end-session-early', {
          sessionUid: od.body.uid,
        });
        t.status(`cycle ${cycle}: ending it succeeds`, ended, 200);
        const after = await fx.activeSession(room.roomUid);
        t.ok(
          `cycle ${cycle}: an AUTO session backfills the freed time`,
          after?.type === 'AUTO' && after.uid !== before.uid,
          `active ${after?.type ?? 'none'}`,
        );
      }
    },
  },

  // -- join codes and auth -------------------------------------------------
  {
    group: 'join codes / auth',
    tags: ['slow'],
    name: 'a-join-code-is-exchangeable-only-inside-its-validity-window',
    async run(t, { fx, api }) {
      // The regression f7b26b6 fixed. fetchJoinCodes pre-mints the *next* code
      // 60s before the current one expires, with validStart == current.validEnd.
      // Checking only validEnd made that future code exchangeable the instant it
      // was minted, stretching a code's usable life from 5 minutes to nearly 10
      // with two codes live through every rotation. Driving the real mint-next
      // path is the point: a hand-written future code would not prove the kiosk
      // handoff still works afterwards.
      const room = await fx.room('joincode');
      const session = await fx.onDemand(room.roomUid, 'joincode');
      const minted = await api.post('session-auth/admin-fetch-join-code', {
        sessionUid: session.body.uid,
      });
      t.ok(
        'a live session mints a current join code',
        minted.body?.status === 'ok',
        `status ${minted.body?.status}`,
      );
      const current = minted.body.joinCode;
      const validEnd = Date.parse(minted.body.validEnd);

      const now = await api.anon('session-auth/exchange-join-code', {
        joinCode: current,
      });
      t.status('the current code exchanges now', now, 200);

      // Into the 60s handoff window, where fetchJoinCodes pre-mints `next`.
      await sleep(Math.max(0, validEnd - Date.now() - 40_000));
      const handoff = await api.device(
        room.device.deviceToken,
        'session-auth/fetch-join-code',
        { sessionUid: session.body.uid },
      );
      t.ok(
        'inside the handoff window the kiosk is handed the next code',
        handoff.status === 200 &&
          handoff.body?.current?.joinCode === current &&
          typeof handoff.body?.next?.joinCode === 'string',
        `current=${handoff.body?.current?.joinCode} next=${handoff.body?.next?.joinCode}`,
      );
      const next = handoff.body.next;
      t.ok(
        'and the next code starts exactly where the current one ends',
        Date.parse(next.validStart) === validEnd,
        `next.validStart=${next.validStart} current.validEnd=${minted.body.validEnd}`,
      );

      const early = await api.anon('session-auth/exchange-join-code', {
        joinCode: next.joinCode,
      });
      t.status(
        'a code before its valid_start is refused 404 JOIN_CODE_NOT_FOUND',
        early,
        404,
        'JOIN_CODE_NOT_FOUND',
      );

      await sleep(Math.max(0, validEnd - Date.now() + 2_000));
      const expired = await api.anon('session-auth/exchange-join-code', {
        joinCode: current,
      });
      t.status(
        'a code past its valid_end is refused 410 JOIN_CODE_EXPIRED',
        expired,
        410,
        'JOIN_CODE_EXPIRED',
      );

      const handedOver = await api.anon('session-auth/exchange-join-code', {
        joinCode: next.joinCode,
      });
      t.status(
        'and the pre-minted handoff code works the moment the old one dies',
        handedOver,
        200,
      );
    },
  },

  {
    group: 'join codes / auth',
    name: 'an-unknown-or-malformed-join-code-is-rejected-without-leaking-anything',
    async run(t, { api }) {
      const unknown = await api.anon('session-auth/exchange-join-code', {
        joinCode: 'ZZZZZZZZ',
      });
      t.status(
        'a well-formed but nonexistent join code is 404 JOIN_CODE_NOT_FOUND',
        unknown,
        404,
        'JOIN_CODE_NOT_FOUND',
      );
      const malformed = await api.anon('session-auth/exchange-join-code', {
        joinCode: 'nope',
      });
      t.ok(
        'a malformed join code is rejected 4xx by the schema',
        malformed.status >= 400 && malformed.status < 500,
        `${malformed.status} ${malformed.body?.code}`,
      );
      const badRefresh = await api.anon('session-auth/refresh-session-token', {
        sessionRefreshToken: 'garbage-without-a-separator',
      });
      t.status(
        'a malformed refresh token is 401 INVALID_REFRESH_TOKEN',
        badRefresh,
        401,
        'INVALID_REFRESH_TOKEN',
      );
    },
  },

  {
    group: 'join codes / auth',
    name: 'a-session-with-no-join-code-scopes-cannot-mint-a-code',
    async run(t, { fx, api }) {
      const room = await fx.room('noscopes');
      const session = await fx.onDemand(room.roomUid, 'noscopes', {
        joinCodeScopes: [],
      });
      t.status('a session with empty joinCodeScopes is accepted', session, 201);

      const admin = await api.post('session-auth/admin-fetch-join-code', {
        sessionUid: session.body.uid,
      });
      t.ok(
        'admin-fetch-join-code answers 200 with status no-join-scopes',
        admin.status === 200 &&
          admin.body?.status === 'no-join-scopes' &&
          admin.body?.joinCode === null,
        `${admin.status} ${JSON.stringify(admin.body)}`,
      );

      const device = await api.device(
        room.device.deviceToken,
        'session-auth/fetch-join-code',
        { sessionUid: session.body.uid },
      );
      t.status(
        'the device-facing route answers 409 JOIN_CODE_SCOPES_EMPTY',
        device,
        409,
        'JOIN_CODE_SCOPES_EMPTY',
      );

      // The source device still gets its own token: joinCodeScopes govern the
      // anonymous join path only, not device auth.
      const token = await api.device(
        room.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.body.uid },
      );
      t.ok(
        'but the room’s source device can still exchange its device token',
        token.status === 200 && token.body?.scopes?.includes('SEND_AUDIO'),
        `${token.status} ${JSON.stringify(token.body?.scopes)}`,
      );
    },
  },

  {
    group: 'join codes / auth',
    name: 'a-device-token-only-works-for-sessions-in-its-own-room',
    async run(t, { fx, api }) {
      const mine = await fx.room('scope-mine');
      const theirs = await fx.room('scope-theirs');
      const session = await fx.onDemand(mine.roomUid, 'scope');

      const own = await api.device(
        mine.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.body.uid },
      );
      t.ok(
        'the room’s own source device gets SEND_AUDIO',
        own.status === 200 && own.body?.scopes?.includes('SEND_AUDIO'),
        `${own.status} ${JSON.stringify(own.body?.scopes)}`,
      );

      const foreign = await api.device(
        theirs.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.body.uid },
      );
      t.status(
        'a device from another room is refused 403',
        foreign,
        403,
        'DEVICE_NOT_IN_SESSION_ROOM',
      );
      const foreignCode = await api.device(
        theirs.device.deviceToken,
        'session-auth/fetch-join-code',
        { sessionUid: session.body.uid },
      );
      t.status(
        'and cannot read its join codes either',
        foreignCode,
        403,
        'DEVICE_NOT_IN_SESSION_ROOM',
      );
    },
  },

  // -- calendar / scheduling ----------------------------------------------
  {
    group: 'calendar / scheduling',
    name: 'an-auto-window-wrapping-past-midnight-materializes-a-session-covering-now',
    async run(t, { fx }) {
      // localEndTime < localStartTime means each occurrence runs into the next
      // day. Sized so the window is 23h long and unambiguously contains now,
      // which no non-wrapping window with these two times could.
      const start = new Date(Date.now() - 60 * 60 * 1000);
      const end = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const room = await fx.room('wrap', { auto: true });
      const win = await fx.window(room.roomUid, {
        localStartTime: utcHms(start).slice(0, 5),
        localEndTime: utcHms(end).slice(0, 5),
      });
      t.status('a midnight-wrapping window is accepted', win, 201);

      const live = await fx.activeSession(room.roomUid);
      t.ok(
        'it materializes an AUTO session covering now',
        live?.type === 'AUTO',
        `active ${live?.type ?? 'none'}`,
      );
      t.ok(
        'whose effective end lands on the following day',
        live !== null &&
          Date.parse(live.effectiveEnd) > Date.now() &&
          Date.parse(live.effectiveEnd) - Date.now() > 20 * 60 * 60 * 1000,
        `end ${live?.effectiveEnd}`,
      );
    },
  },

  {
    group: 'calendar / scheduling',
    name: 'an-auto-window-starting-now-covers-the-rest-of-today',
    async run(t, { fx }) {
      // `inRange` clips an occurrence to `activeStart` rather than dropping
      // it. The daily 00:00-23:59 window the admin console creates started at
      // midnight, before any `activeStart` an operator can type, so dropping
      // meant "auto sessions, every day, from now" produced nothing until the
      // next local midnight - with no explanation, and with the admin dialog
      // forcing `activeStart` into the future to hide it.
      const today = await fx.room('as-today', { auto: true });
      const startedNow = new Date();
      await fx.window(today.roomUid, {
        activeStart: startedNow.toISOString(),
      });
      const live = await fx.activeSession(today.roomUid);
      t.ok(
        'a window whose activeStart is "now" produces a session covering now',
        live?.type === 'AUTO',
        `active ${live?.type ?? 'none'}`,
      );
      t.ok(
        'and that session starts at activeStart, not at the occurrence’s midnight',
        live !== null &&
          Math.abs(Date.parse(live.effectiveStart) - startedNow.getTime()) <
            5 * 60_000,
        `effectiveStart ${live?.effectiveStart} vs activeStart ${startedNow.toISOString()}`,
      );
      t.ok(
        'and it still runs to the end of the local day',
        live !== null && Date.parse(live.effectiveEnd) > Date.now(),
        `effectiveEnd ${live?.effectiveEnd}`,
      );

      const backdated = await fx.room('as-backdated', { auto: true });
      await fx.window(backdated.roomUid);
      const older = await fx.activeSession(backdated.roomUid);
      t.ok(
        'the same window backdated a week also covers now',
        older?.type === 'AUTO',
        `active ${older?.type ?? 'none'}`,
      );
    },
  },

  {
    group: 'calendar / scheduling',
    name: 'overlapping-auto-windows-in-one-room-are-refused',
    async run(t, { fx }) {
      const room = await fx.room('overlap', { auto: true });
      const first = await fx.window(room.roomUid, {
        localStartTime: '08:00',
        localEndTime: '12:00',
      });
      t.status('the first window is accepted', first, 201);
      const clash = await fx.window(room.roomUid, {
        localStartTime: '10:00',
        localEndTime: '14:00',
      });
      t.status(
        'a window overlapping it is refused 409 CONFLICT',
        clash,
        409,
        'CONFLICT',
      );
      const abutting = await fx.window(room.roomUid, {
        localStartTime: '12:00',
        localEndTime: '14:00',
      });
      t.status('a window that merely abuts it is accepted', abutting, 201);
    },
  },

  {
    group: 'calendar / scheduling',
    name: 'a-spring-forward-gap-swallows-occurrences-that-fall-entirely-inside-it',
    async run(t, { fx }) {
      // America/Chicago springs forward at 02:00 local, so 02:00:00-02:59:59
      // does not exist that day. `buildOccurrence` snaps both endpoints to the
      // transition instant and returns null when they coincide, so an
      // occurrence wholly inside the gap disappears. Observable through the
      // conflict detector: two schedules that overlap on paper do not conflict
      // on the gap day, because neither produces an occurrence.
      const zone = 'America/Chicago';
      const spring = nextTransitions(zone, new Date(), 4).find(
        (x) => x.toOffset > x.fromOffset,
      );
      if (!spring) {
        return { skipped: `no spring-forward transition found for ${zone}` };
      }
      const dow = localDayOfWeek(zone, new Date(spring.at.getTime() + 60_000));
      const activeStart = new Date(spring.at.getTime() - 8 * 60 * 60 * 1000);
      const activeEnd = new Date(spring.at.getTime() + 16 * 60 * 60 * 1000);
      const pair = (roomUid, ls, le) => ({
        frequency: 'WEEKLY',
        daysOfWeek: [dow],
        activeStart: activeStart.toISOString(),
        activeEnd: activeEnd.toISOString(),
        localStartTime: ls,
        localEndTime: le,
        roomUid,
      });

      const gap = await fx.room('dst-gap', { timezone: zone });
      const g1 = await fx.schedule(
        gap.roomUid,
        pair(gap.roomUid, '02:00', '02:59'),
      );
      const g2 = await fx.schedule(
        gap.roomUid,
        pair(gap.roomUid, '02:15', '02:45'),
      );
      t.ok(
        'a 02:00-02:59 schedule on the spring-forward day is accepted',
        g1.status === 201,
        `${g1.status} ${g1.body?.code ?? ''}`,
      );
      t.ok(
        'and a 02:15-02:45 one does NOT conflict with it - both vanish into the gap',
        g2.status === 201,
        `${g2.status} ${g2.body?.code ?? ''} (transition at ${spring.at.toISOString()})`,
      );

      const same = await fx.room('dst-same-day', { timezone: zone });
      const s1 = await fx.schedule(
        same.roomUid,
        pair(same.roomUid, '03:30', '04:30'),
      );
      const s2 = await fx.schedule(
        same.roomUid,
        pair(same.roomUid, '03:45', '04:15'),
      );
      t.ok(
        'on that same day, times after the transition DO conflict',
        s1.status === 201 && s2.status === 409 && s2.body?.code === 'CONFLICT',
        `${s1.status}/${s2.status} ${s2.body?.code ?? ''}`,
      );

      const week = await fx.room('dst-next-week', { timezone: zone });
      const later = (ls, le) => ({
        ...pair(week.roomUid, ls, le),
        activeStart: new Date(activeStart.getTime() + 7 * DAY_MS).toISOString(),
        activeEnd: new Date(activeEnd.getTime() + 7 * DAY_MS).toISOString(),
      });
      const w1 = await fx.schedule(week.roomUid, later('02:00', '02:59'));
      const w2 = await fx.schedule(week.roomUid, later('02:15', '02:45'));
      t.ok(
        'and the identical 02:xx pair one week later does conflict',
        w1.status === 201 && w2.status === 409 && w2.body?.code === 'CONFLICT',
        `${w1.status}/${w2.status} ${w2.body?.code ?? ''}`,
      );
    },
  },

  {
    group: 'calendar / scheduling',
    name: 'a-fall-back-ambiguous-local-time-resolves-to-the-standard-time-instant',
    async run(t, { fx }) {
      // At fall-back, local 01:00-01:59 happens twice. `localToUtc` picks the
      // LATER (standard-time) instant, so an occurrence at 01:15-01:45 local
      // lands *after* the transition, not before it.
      //
      // Conflict detection alone cannot see this: local -> UTC is strictly
      // increasing under either reading, so overlap decisions are identical.
      // What does distinguish them is where `activeEnd` cuts. Both occurrences
      // sit wholly inside the ambiguous hour, and `activeEnd` is placed at the
      // transition instant itself: under the daylight reading they precede it
      // and survive (and conflict); under the standard reading they begin
      // after it, clip to nothing, and vanish. So "no conflict" here is a
      // positive statement that the later instant was chosen, and the control
      // below proves the pair does conflict once it is inside the range.
      const zone = 'America/Chicago';
      const fall = nextTransitions(zone, new Date(), 4).find(
        (x) => x.toOffset < x.fromOffset,
      );
      if (!fall) {
        return { skipped: `no fall-back transition found for ${zone}` };
      }
      const dow = localDayOfWeek(zone, new Date(fall.at.getTime() + 60_000));
      const activeStart = new Date(fall.at.getTime() - 8 * 60 * 60 * 1000);
      // Under the daylight reading 01:15-01:45 runs from 45 to 15 minutes
      // BEFORE the transition instant; under the standard reading, from 15 to
      // 45 minutes after it.
      const atTransition = new Date(fall.at.getTime());
      const afterBoth = new Date(fall.at.getTime() + 60 * 60_000);
      const pair = (roomUid, ls, le, activeEnd) => ({
        roomUid,
        frequency: 'WEEKLY',
        daysOfWeek: [dow],
        activeStart: activeStart.toISOString(),
        activeEnd: activeEnd.toISOString(),
        localStartTime: ls,
        localEndTime: le,
      });

      const decisive = await fx.room('dst-fall', { timezone: zone });
      const d1 = await fx.schedule(
        decisive.roomUid,
        pair(decisive.roomUid, '01:15', '01:45', atTransition),
      );
      const d2 = await fx.schedule(
        decisive.roomUid,
        pair(decisive.roomUid, '01:20', '01:40', atTransition),
      );
      t.ok(
        'with activeEnd at the transition instant both occurrences fall outside it and vanish',
        d1.status === 201 && d2.status === 201,
        `${d1.status}/${d2.status} ${d2.body?.code ?? ''} ` +
          `(transition at ${fall.at.toISOString()})`,
      );

      const control = await fx.room('dst-fall-ctl', { timezone: zone });
      const c1 = await fx.schedule(
        control.roomUid,
        pair(control.roomUid, '01:15', '01:45', afterBoth),
      );
      const c2 = await fx.schedule(
        control.roomUid,
        pair(control.roomUid, '01:20', '01:40', afterBoth),
      );
      t.ok(
        'with activeEnd past the standard reading they survive and conflict',
        c1.status === 201 && c2.status === 409 && c2.body?.code === 'CONFLICT',
        `${c1.status}/${c2.status} ${c2.body?.code ?? ''}`,
      );
    },
  },

  {
    group: 'calendar / scheduling',
    name: 'once-weekly-and-biweekly-schedules-materialize-and-the-biweekly-anchor-survives-an-update',
    async run(t, { fx, api }) {
      const once = await fx.room('freq-once');
      const at = new Date(Date.now() + 5 * 60_000);
      await fx.schedule(once.roomUid, {
        frequency: 'ONCE',
        daysOfWeek: null,
        localStartTime: utcHms(at),
        localEndTime: utcHms(new Date(at.getTime() + 60_000)),
      });
      const onceSessions = await fx.listSessions(
        once.roomUid,
        -60_000,
        8 * DAY_MS,
      );
      t.ok(
        'a ONCE schedule materializes exactly one occurrence',
        onceSessions.length === 1,
        `${onceSessions.length} session(s)`,
      );

      const weekly = await fx.room('freq-weekly');
      await fx.schedule(weekly.roomUid, {
        frequency: 'WEEKLY',
        daysOfWeek: ALL_DAYS,
        localStartTime: '09:00',
        localEndTime: '10:00',
      });
      const weeklySessions = await fx.listSessions(
        weekly.roomUid,
        -60_000,
        8 * DAY_MS,
      );
      t.ok(
        'a daily WEEKLY schedule materializes one occurrence per day inside the 7-day horizon',
        weeklySessions.length >= 6 && weeklySessions.length <= 8,
        `${weeklySessions.length} session(s)`,
      );

      const biweekly = await fx.room('freq-biweekly');
      const created = await fx.schedule(biweekly.roomUid, {
        frequency: 'BIWEEKLY',
        daysOfWeek: ALL_DAYS,
        localStartTime: '09:00',
        localEndTime: '10:00',
      });
      t.status('a BIWEEKLY schedule is accepted', created, 201);
      t.ok(
        'its anchor starts equal to its activeStart',
        created.body?.anchorStart === created.body?.activeStart,
        `anchor ${created.body?.anchorStart}`,
      );

      // updateSchedule closes the old row and inserts a new one; the anchor
      // must be carried verbatim or the biweekly cadence silently shifts by a
      // week for every future occurrence.
      const updated = await api.post('schedule-management/update-schedule', {
        scheduleUid: created.body.uid,
        name: fx.name('freq-biweekly-renamed'),
        activeStart: new Date(Date.now() + 20 * DAY_MS).toISOString(),
      });
      t.status('and it can be updated', updated, 200);
      t.ok(
        'the BIWEEKLY parity anchor survives the update unchanged',
        updated.body?.anchorStart === created.body?.anchorStart,
        `${created.body?.anchorStart} -> ${updated.body?.anchorStart}`,
      );
      t.ok(
        'even though activeStart moved',
        updated.body?.activeStart !== created.body?.activeStart,
        `${created.body?.activeStart} -> ${updated.body?.activeStart}`,
      );
    },
  },

  {
    group: 'calendar / scheduling',
    name: 'schedules-and-sessions-outside-the-listing-and-materialization-horizons',
    async run(t, { fx, api }) {
      const room = await fx.room('horizon');
      const far = new Date(Date.now() + 120 * DAY_MS);
      const created = await fx.schedule(room.roomUid, {
        activeStart: far.toISOString(),
      });
      t.status('a schedule starting 120 days out is accepted', created, 201);

      const ranged = await api.get(
        `schedule-management/list-schedules?roomUid=${room.roomUid}` +
          `&from=${encodeURIComponent(new Date().toISOString())}` +
          `&to=${encodeURIComponent(new Date(Date.now() + 90 * DAY_MS).toISOString())}`,
      );
      t.pin(
        'but it is invisible to a 90-day ranged listing',
        ranged.body?.items?.length === 0,
        `${ranged.body?.items?.length} item(s) in the 90-day range`,
        'QUIRK-4',
      );
      const unranged = await api.get(
        `schedule-management/list-schedules?roomUid=${room.roomUid}`,
      );
      t.ok(
        'and only an unbounded listing shows it',
        unranged.body?.items?.length === 1,
        `${unranged.body?.items?.length} item(s) unranged`,
      );

      const soon = await fx.room('horizon-7d');
      await fx.schedule(soon.roomUid, {
        activeStart: new Date(Date.now() + 10 * DAY_MS).toISOString(),
      });
      const sessions = await fx.listSessions(
        soon.roomUid,
        -60_000,
        30 * DAY_MS,
      );
      t.ok(
        'a schedule beyond the 7-day materialization horizon has no sessions yet',
        sessions.length === 0,
        `${sessions.length} session(s): ${sessions.map((s) => s.effectiveStart).join(', ')}`,
      );

      const tooWide = await api.get(
        `schedule-management/list-sessions?roomUids=${soon.roomUid}` +
          `&from=${encodeURIComponent(new Date().toISOString())}` +
          `&to=${encodeURIComponent(new Date(Date.now() + 32 * DAY_MS).toISOString())}`,
      );
      t.status(
        'list-sessions refuses a range longer than 31 days',
        tooWide,
        422,
        'RANGE_TOO_LARGE',
      );
    },
  },

  {
    group: 'calendar / scheduling',
    name: 'an-activeEnd-inside-an-occurrence-clips-it-instead-of-dropping-it',
    async run(t, { fx, api }) {
      // `inRange` clips an occurrence to `activeEnd` rather than rejecting it.
      // For the daily 00:00-23:59 window the admin console creates, dropping
      // meant *any* activeEnd before 23:59 removed the whole day: "auto
      // sessions until 15:00" produced none at all, and narrowing a *live*
      // window ended the session that was running right then.
      const stopFresh = new Date(Date.now() + 30 * 60_000);
      const fresh = await fx.room('clip-fresh', { auto: true });
      await fx.window(fresh.roomUid, {
        activeEnd: stopFresh.toISOString(),
      });
      const clipped = await fx.activeSession(fresh.roomUid);
      t.ok(
        'a window whose activeEnd lands mid-occurrence still produces a session covering now',
        clipped?.type === 'AUTO',
        `active ${clipped?.type ?? 'none'}`,
      );
      t.ok(
        'and that session ends at activeEnd, not at the occurrence’s own end',
        clipped !== null &&
          Math.abs(Date.parse(clipped.effectiveEnd) - stopFresh.getTime()) <
            60_000,
        `effectiveEnd ${clipped?.effectiveEnd} vs activeEnd ${stopFresh.toISOString()}`,
      );

      const live = await fx.room('clip-live', { auto: true });
      const win = await fx.window(live.roomUid);
      const before = await fx.activeSession(live.roomUid);
      t.ok(
        'a live AUTO session exists before the window is narrowed',
        before?.type === 'AUTO',
        `active ${before?.type ?? 'none'}`,
      );
      const stopAt = new Date(Date.now() + 30 * 60_000);
      const narrowed = await api.post(
        'schedule-management/update-auto-session-window',
        { windowUid: win.body.uid, activeEnd: stopAt.toISOString() },
      );
      t.status('narrowing the live window succeeds', narrowed, 200);
      const after = await api.get(
        `schedule-management/get-active-session/${live.roomUid}`,
      );
      t.ok(
        'and the running AUTO session survives, now ending at the new activeEnd',
        after.body !== null &&
          after.body.uid === before?.uid &&
          Math.abs(Date.parse(after.body.effectiveEnd) - stopAt.getTime()) <
            60_000,
        after.body === null
          ? `no active session, though the operator asked for one until ${stopAt.toISOString()}`
          : `session ${after.body.uid} (was ${before?.uid}) active until ${after.body.effectiveEnd}`,
      );
    },
  },

  {
    group: 'calendar / scheduling',
    name: 'turning-auto-sessions-off-ends-the-live-auto-session',
    async run(t, { fx, api }) {
      const room = await fx.room('toggle', { auto: true });
      await fx.window(room.roomUid);
      const live = await fx.activeSession(room.roomUid);
      t.ok('an AUTO session is live', live?.type === 'AUTO', `${live?.type}`);

      const off = await api.post(
        'schedule-management/update-room-schedule-config',
        { roomUid: room.roomUid, autoSessionEnabled: false },
      );
      t.status('autoSessionEnabled can be turned off', off, 200);
      const after = await api.get(
        `schedule-management/get-session/${live.uid}`,
      );
      t.ok(
        'the live AUTO session is ended via end_override',
        after.body?.endOverride !== null &&
          Date.parse(after.body.effectiveEnd) <= Date.now(),
        `endOverride ${after.body?.endOverride}`,
      );
      const none = await api.get(
        `schedule-management/get-active-session/${room.roomUid}`,
      );
      t.ok(
        'and the room has no active session',
        none.body === null,
        JSON.stringify(none.body),
      );

      const on = await api.post(
        'schedule-management/update-room-schedule-config',
        { roomUid: room.roomUid, autoSessionEnabled: true },
      );
      t.status('turning it back on succeeds', on, 200);
      const resumed = await fx.activeSession(room.roomUid);
      t.ok(
        'and materialization resumes from the untouched window',
        resumed?.type === 'AUTO' && resumed.uid !== live.uid,
        `active ${resumed?.type ?? 'none'}`,
      );
    },
  },

  {
    group: 'calendar / scheduling',
    name: 'deleting-a-window-or-a-schedule-cleans-up-what-it-materialized',
    async run(t, { fx, api }) {
      const room = await fx.room('del-window', { auto: true });
      const win = await fx.window(room.roomUid);
      const live = await fx.activeSession(room.roomUid);
      const deleted = await api.post(
        'schedule-management/delete-auto-session-window',
        { windowUid: win.body.uid },
      );
      t.status(
        'deleting a window with a live AUTO session succeeds',
        deleted,
        204,
      );
      const ended = await api.get(
        `schedule-management/get-session/${live.uid}`,
      );
      t.ok(
        'the live AUTO session is ended, not orphaned',
        ended.body?.endOverride !== null,
        `endOverride ${ended.body?.endOverride}`,
      );
      const gone = await api.post(
        'schedule-management/delete-auto-session-window',
        { windowUid: win.body.uid },
      );
      t.status(
        'deleting it again is 404 WINDOW_NOT_FOUND',
        gone,
        404,
        'WINDOW_NOT_FOUND',
      );

      const sched = await fx.room('del-schedule');
      const created = await fx.schedule(sched.roomUid, {
        activeStart: new Date(Date.now() + 60_000).toISOString(),
      });
      const before = await fx.listSessions(sched.roomUid, -60_000, 8 * DAY_MS);
      t.ok(
        'a schedule materializes upcoming sessions',
        before.length > 0,
        `${before.length} session(s)`,
      );
      const removed = await api.post('schedule-management/delete-schedule', {
        scheduleUid: created.body.uid,
      });
      t.status('deleting the schedule succeeds', removed, 204);
      const after = await fx.listSessions(sched.roomUid, -60_000, 8 * DAY_MS);
      t.ok(
        'and its upcoming sessions go with it',
        after.length === 0,
        `${after.length} session(s) left`,
      );
    },
  },

  // -- rooms and devices ---------------------------------------------------
  {
    group: 'rooms / devices',
    name: 'a-room-takes-exactly-one-source-device',
    async run(t, { fx, api }) {
      const a = await fx.device('two-src-a');
      const b = await fx.device('two-src-b');
      const both = await api.post('room-management/create-room', {
        name: fx.name('two-src'),
        timezone: 'UTC',
        autoSessionEnabled: false,
        sourceDeviceUids: [a.deviceUid, b.deviceUid],
      });
      t.status(
        'creating a room with two source devices is refused',
        both,
        409,
        'TOO_MANY_SOURCE_DEVICES',
      );
      const none = await api.post('room-management/create-room', {
        name: fx.name('no-src'),
        timezone: 'UTC',
        autoSessionEnabled: false,
        sourceDeviceUids: [],
      });
      t.ok(
        'and creating one with no source device is refused too',
        none.status >= 400 && none.status < 500,
        `${none.status} ${none.body?.code}`,
      );

      // `add-device-to-room` used to publish a 409 TOO_MANY_SOURCE_DEVICES
      // reply that nothing could produce: only `createRoom` emitted that code.
      // The service ran no "this room already has a source" check, and the
      // repository's `asSource` branch clears `is_source` across the whole room
      // before inserting - so the call silently demoted the room's kiosk and
      // answered 204. It now refuses, and a deliberate swap goes through
      // `set-source-device`, which is asserted below.
      const room = await fx.room('one-src');
      const session = await fx.onDemand(room.roomUid, 'one-src');
      const beforeScopes = await api.device(
        room.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.body.uid },
      );
      t.ok(
        'the room’s source device has SEND_AUDIO before anything is added',
        beforeScopes.body?.scopes?.includes('SEND_AUDIO'),
        JSON.stringify(beforeScopes.body?.scopes),
      );

      const second = await api.post('room-management/add-device-to-room', {
        roomUid: room.roomUid,
        deviceUid: b.deviceUid,
        asSource: true,
      });
      t.status(
        'adding a second device asSource is refused 409 TOO_MANY_SOURCE_DEVICES',
        second,
        409,
        'TOO_MANY_SOURCE_DEVICES',
      );

      const afterScopes = await api.device(
        room.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.body.uid },
      );
      t.ok(
        'and the original source keeps SEND_AUDIO',
        afterScopes.status === 200 &&
          afterScopes.body?.scopes?.includes('SEND_AUDIO'),
        `original source scopes are ${JSON.stringify(afterScopes.body?.scopes)}`,
      );

      // The deliberate replace-the-source flow the refusal points at. A kiosk
      // really does get swapped sometimes (broken hardware), so this has to
      // keep working - it is now two calls instead of one silent side effect.
      const asMember = await api.post('room-management/add-device-to-room', {
        roomUid: room.roomUid,
        deviceUid: b.deviceUid,
        asSource: false,
      });
      t.status(
        'the same device can be attached as a plain member',
        asMember,
        204,
      );
      const promote = await api.post('room-management/set-source-device', {
        roomUid: room.roomUid,
        deviceUid: b.deviceUid,
      });
      t.status('and set-source-device then promotes it', promote, 204);

      const promoted = await api.device(
        b.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.body.uid },
      );
      t.ok(
        'after which the promoted device holds SEND_AUDIO',
        promoted.body?.scopes?.includes('SEND_AUDIO'),
        JSON.stringify(promoted.body?.scopes),
      );
      const demoted = await api.device(
        room.device.deviceToken,
        'session-auth/exchange-device-token',
        { sessionUid: session.body.uid },
      );
      t.ok(
        'and the device it replaced no longer does',
        demoted.status === 200 && !demoted.body?.scopes?.includes('SEND_AUDIO'),
        `replaced source scopes are ${JSON.stringify(demoted.body?.scopes)}`,
      );
    },
  },

  {
    group: 'rooms / devices',
    name: 'a-device-cannot-belong-to-two-rooms',
    async run(t, { fx, api }) {
      const a = await fx.room('two-rooms-a');
      const b = await fx.room('two-rooms-b');
      const asMember = await api.post('room-management/add-device-to-room', {
        roomUid: b.roomUid,
        deviceUid: a.device.deviceUid,
        asSource: false,
      });
      t.status(
        'adding a room’s device to a second room is refused',
        asMember,
        409,
        'DEVICE_ALREADY_IN_ROOM',
      );
      const asSource = await api.post('room-management/add-device-to-room', {
        roomUid: b.roomUid,
        deviceUid: a.device.deviceUid,
        asSource: true,
      });
      t.status(
        'and so is adding it as that room’s source',
        asSource,
        409,
        'DEVICE_ALREADY_IN_ROOM',
      );
    },
  },

  {
    group: 'rooms / devices',
    name: 'a-rooms-source-device-cannot-be-deleted-or-detached',
    async run(t, { fx, api }) {
      const room = await fx.room('src-lock');
      const del = await api.post('device-management/delete-device', {
        deviceUid: room.device.deviceUid,
      });
      t.status(
        'deleting a room’s source device is refused',
        del,
        409,
        'WOULD_LEAVE_ROOM_WITHOUT_SOURCE',
      );
      const detach = await api.post('room-management/remove-device-from-room', {
        deviceUid: room.device.deviceUid,
      });
      t.status(
        'and detaching it from its room is refused',
        detach,
        409,
        'WOULD_LEAVE_ROOM_WITHOUT_SOURCE',
      );
    },
  },

  {
    group: 'rooms / devices',
    name: 'deleting-a-room-with-a-live-session-cascades-the-session',
    async run(t, { fx, api }) {
      const room = await fx.room('del-live');
      const session = await fx.onDemand(room.roomUid, 'del-live');
      const code = await api.post('session-auth/admin-fetch-join-code', {
        sessionUid: session.body.uid,
      });
      t.ok('the session is live and joinable', code.body?.status === 'ok', '');

      const deleted = await api.post('room-management/delete-room', {
        roomUid: room.roomUid,
      });
      t.status('the room deletes despite the live session', deleted, 204);
      fx.rooms = fx.rooms.filter((r) => r !== room.roomUid);

      const gone = await api.get(
        `schedule-management/get-session/${session.body.uid}`,
      );
      t.status('the session is gone with it', gone, 404, 'SESSION_NOT_FOUND');
      const orphanCode = await api.anon('session-auth/exchange-join-code', {
        joinCode: code.body.joinCode,
      });
      t.status(
        'and its join code no longer exchanges',
        orphanCode,
        404,
        'JOIN_CODE_NOT_FOUND',
      );
    },
  },

  {
    group: 'rooms / devices',
    name: 'reserved-demo-and-canary-uids-are-refused-for-assignment',
    async run(t, { fx, api }) {
      // These guards run before any existence lookup on purpose, so the answer
      // does not depend on whether the seeder ran on this deployment.
      const room = await fx.room('reserved');
      const toDemo = await api.post('room-management/add-device-to-room', {
        roomUid: DEMO_ROOM_UID,
        deviceUid: room.device.deviceUid,
        asSource: false,
      });
      t.status(
        'a device cannot be added to the demo room',
        toDemo,
        409,
        'DEMO_ROOM_NOT_ASSIGNABLE',
      );
      const toCanary = await api.post('room-management/add-device-to-room', {
        roomUid: CANARY_ROOM_UID,
        deviceUid: room.device.deviceUid,
        asSource: false,
      });
      t.status(
        'nor to the monitoring canary room',
        toCanary,
        409,
        'CANARY_ROOM_NOT_ASSIGNABLE',
      );
      const demoSource = await api.post('room-management/create-room', {
        name: fx.name('reserved-demo-src'),
        timezone: 'UTC',
        autoSessionEnabled: false,
        sourceDeviceUids: [DEMO_SOURCE_DEVICE_UID],
      });
      t.status(
        'the demo room’s placeholder source cannot become a real room’s source',
        demoSource,
        409,
        'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE',
      );
      const canarySource = await api.post('room-management/create-room', {
        name: fx.name('reserved-canary-src'),
        timezone: 'UTC',
        autoSessionEnabled: false,
        sourceDeviceUids: [CANARY_DEVICE_UID],
      });
      t.status(
        'nor can the canary device - the guard that keeps fixture speech out of a lecture',
        canarySource,
        409,
        'CANARY_DEVICE_NOT_ASSIGNABLE',
      );
      const delDemo = await api.post('room-management/delete-room', {
        roomUid: DEMO_ROOM_UID,
      });
      t.status(
        'the demo room cannot be deleted',
        delDemo,
        409,
        'DEMO_ROOM_NOT_DELETABLE',
      );
      const delDemoDevice = await api.post('device-management/delete-device', {
        deviceUid: DEMO_SOURCE_DEVICE_UID,
      });
      t.status(
        'and neither can its placeholder source device',
        delDemoDevice,
        409,
        'DEMO_SOURCE_DEVICE_NOT_DELETABLE',
      );

      // The test-audio rooms are only seeded when TEST_AUDIO_DEVICE_SECRET is
      // set, so they are discovered rather than assumed.
      const rooms = await api.get('room-management/list-rooms?limit=100');
      const testAudio = (rooms.body?.items ?? []).find((r) =>
        r.name?.startsWith('TEST-AUDIO-'),
      );
      if (testAudio) {
        const toTestAudio = await api.post(
          'room-management/add-device-to-room',
          {
            roomUid: testAudio.uid,
            deviceUid: room.device.deviceUid,
            asSource: false,
          },
        );
        t.status(
          'a device cannot be added to a seeded test-audio room',
          toTestAudio,
          409,
          'TEST_AUDIO_ROOM_NOT_ASSIGNABLE',
        );
      }
    },
  },

  {
    group: 'rooms / devices',
    name: 'an-activation-code-is-single-use-and-advertises-a-five-minute-expiry',
    async run(t, { fx, api }) {
      const reg = await api.post('device-management/register-device', {
        name: fx.name('activation'),
      });
      t.ok(
        'register-device issues an activation code',
        reg.status === 201,
        `${reg.status}`,
      );
      fx.devices.push(reg.body.deviceUid);

      const ttlMs = Date.parse(reg.body.expiry) - Date.now();
      t.ok(
        'the code advertises a ~5 minute expiry',
        ttlMs > 4 * 60_000 && ttlMs <= 5 * 60_000 + 30_000,
        `${Math.round(ttlMs / 1000)}s`,
      );

      const first = await api.anon('device-management/activate-device', {
        activationCode: reg.body.activationCode,
      });
      t.ok(
        'the first activation succeeds',
        first.status === 200,
        `${first.status}`,
      );
      const second = await api.anon('device-management/activate-device', {
        activationCode: reg.body.activationCode,
      });
      t.status(
        'the same code cannot be redeemed twice',
        second,
        404,
        'ACTIVATION_CODE_NOT_FOUND',
      );
      const unknown = await api.anon('device-management/activate-device', {
        activationCode: 'ZZZZZZZZ',
      });
      t.status(
        'and an unknown code is 404',
        unknown,
        404,
        'ACTIVATION_CODE_NOT_FOUND',
      );
    },
  },

  // -- invalid input -------------------------------------------------------
  {
    group: 'invalid input',
    name: 'an-unknown-transcriptionProviderId-is-refused-on-every-write-path',
    async run(t, { fx, api }) {
      // 16e07c9. Answered at write time because the alternative surfaces at
      // stream time: transcription-service closes the upstream 1007, node-server
      // retries a permanently unsatisfiable request, and every viewer of that
      // room watches a banner promising a reconnection that cannot happen.
      const room = await fx.room('provider', { auto: true });
      const typo = 'whipser';

      const od = await fx.onDemand(room.roomUid, 'provider', {
        transcriptionProviderId: typo,
      });
      t.status('create-on-demand-session refuses it', od, 400);
      t.ok(
        'and the message names the providers this deployment does have',
        /Configured providers:/.test(od.body?.message ?? ''),
        od.body?.message ?? '',
      );

      const sched = await fx.schedule(room.roomUid, {
        transcriptionProviderId: typo,
      });
      t.status('create-schedule refuses it', sched, 400);

      const win = await fx.window(room.roomUid, {
        transcriptionProviderId: typo,
      });
      t.status('create-auto-session-window refuses it', win, 400);

      const goodWindow = await fx.window(room.roomUid);
      const updatedWindow = await api.post(
        'schedule-management/update-auto-session-window',
        { windowUid: goodWindow.body.uid, transcriptionProviderId: typo },
      );
      t.status('update-auto-session-window refuses it', updatedWindow, 400);

      const goodSchedule = await fx.schedule(room.roomUid, {
        localStartTime: '01:00',
        localEndTime: '02:00',
        activeStart: new Date(Date.now() + 60_000).toISOString(),
      });
      const updatedSchedule = await api.post(
        'schedule-management/update-schedule',
        { scheduleUid: goodSchedule.body.uid, transcriptionProviderId: typo },
      );
      t.status('update-schedule refuses it', updatedSchedule, 400);
    },
  },

  {
    group: 'invalid input',
    name: 'an-invalid-timezone-is-refused',
    async run(t, { fx, api }) {
      const device = await fx.device('tz');
      const bad = await api.post('room-management/create-room', {
        name: fx.name('tz-bad'),
        timezone: 'Mars/Olympus_Mons',
        autoSessionEnabled: false,
        sourceDeviceUids: [device.deviceUid],
      });
      t.status(
        'a non-IANA timezone is refused 422 INVALID_TIMEZONE',
        bad,
        422,
        'INVALID_TIMEZONE',
      );
      const empty = await api.post('room-management/create-room', {
        name: fx.name('tz-empty'),
        timezone: '',
        autoSessionEnabled: false,
        sourceDeviceUids: [device.deviceUid],
      });
      t.ok(
        'and so is an empty one',
        empty.status >= 400 && empty.status < 500,
        `${empty.status} ${empty.body?.code}`,
      );
      const alias = await api.post('room-management/create-room', {
        name: fx.name('tz-alias'),
        timezone: 'Etc/UTC',
        autoSessionEnabled: false,
        sourceDeviceUids: [device.deviceUid],
      });
      t.ok(
        'while an alias like Etc/UTC that Intl.supportedValuesOf omits is accepted',
        alias.status === 201,
        `${alias.status} ${alias.body?.code ?? ''}`,
      );
      if (alias.status === 201) fx.rooms.push(alias.body.uid);
    },
  },

  {
    group: 'invalid input',
    name: 'equal-local-start-and-end-times-are-refused-on-schedules-and-windows',
    async run(t, { fx, api }) {
      const room = await fx.room('equal-times', { auto: true });

      const schedule = await fx.schedule(room.roomUid, {
        localStartTime: '10:00',
        localEndTime: '10:00',
      });
      t.status(
        'a schedule with localStartTime == localEndTime is refused 400',
        schedule,
        400,
      );

      // The window path used to have no equivalent pre-check, so the
      // `auto_session_windows_local_times_distinct` CHECK fired inside the
      // transaction and the operator got a 500 for the same typo the schedule
      // path answers with a sentence.
      const window = await fx.window(room.roomUid, {
        localStartTime: '10:00',
        localEndTime: '10:00',
      });
      t.ok(
        'an auto-session window with equal local times is refused 400, like a schedule',
        window.status === 400 &&
          window.body?.code === 'VALIDATION_ERROR' &&
          /must not be equal/.test(window.body?.message ?? ''),
        `got ${window.status} ${window.body?.code ?? ''} ${window.body?.message ?? ''}`,
      );

      const good = await fx.window(room.roomUid, {
        localStartTime: '08:00',
        localEndTime: '09:00',
      });
      // `08:00` against a row that reads back as `08:00:00`: the same time of
      // day, different strings, so a string-equality pre-check would miss it
      // and let the CHECK constraint answer instead.
      const narrowed = await api.post(
        'schedule-management/update-auto-session-window',
        { windowUid: good.body.uid, localEndTime: '08:00' },
      );
      t.ok(
        'and so is updating an existing window to the same local time in a different format',
        narrowed.status === 400 && narrowed.body?.code === 'VALIDATION_ERROR',
        `got ${narrowed.status} ${narrowed.body?.code ?? ''} ${narrowed.body?.message ?? ''}`,
      );
      const survived = await api.get(
        `schedule-management/get-auto-session-window/${good.body.uid}`,
      );
      t.ok(
        'the failed update at least rolls back and leaves the window intact',
        survived.status === 200 &&
          survived.body?.localEndTime?.startsWith('09:00') &&
          survived.body?.activeEnd === null,
        `${survived.status} localEndTime=${survived.body?.localEndTime} activeEnd=${survived.body?.activeEnd}`,
      );
    },
  },

  {
    group: 'invalid input',
    name: 'malformed-uuids-and-unknown-uids-are-rejected-distinctly',
    async run(t, { api }) {
      const absent = '00000000-0000-4000-8000-000000000000';
      const malformed = await api.post(
        'schedule-management/end-session-early',
        {
          sessionUid: 'not-a-uuid',
        },
      );
      t.status(
        'a malformed session uid is a 400 validation error',
        malformed,
        400,
        'VALIDATION_ERROR',
      );
      const unknownSession = await api.post(
        'schedule-management/end-session-early',
        { sessionUid: absent },
      );
      t.status(
        'a well-formed unknown session uid is 404 SESSION_NOT_FOUND',
        unknownSession,
        404,
        'SESSION_NOT_FOUND',
      );
      const unknownRoom = await api.get(
        `schedule-management/get-active-session/${absent}`,
      );
      t.status(
        'an unknown room uid is 404 ROOM_NOT_FOUND, not a null active session',
        unknownRoom,
        404,
        'ROOM_NOT_FOUND',
      );
      const unknownWindow = await api.post(
        'schedule-management/delete-auto-session-window',
        { windowUid: absent },
      );
      t.status(
        'an unknown window uid is 404 WINDOW_NOT_FOUND',
        unknownWindow,
        404,
        'WINDOW_NOT_FOUND',
      );
      const unknownSchedule = await api.get(
        `schedule-management/get-schedule/${absent}`,
      );
      t.status(
        'an unknown schedule uid is 404 SCHEDULE_NOT_FOUND',
        unknownSchedule,
        404,
        'SCHEDULE_NOT_FOUND',
      );
    },
  },

  {
    group: 'invalid input',
    name: 'frequency-and-daysOfWeek-must-agree-and-active-ranges-must-be-ordered',
    async run(t, { fx }) {
      const room = await fx.room('freq-validation');

      const onceWithDays = await fx.schedule(room.roomUid, {
        frequency: 'ONCE',
        daysOfWeek: ['MON'],
      });
      t.status(
        'a ONCE schedule with daysOfWeek is refused 400',
        onceWithDays,
        400,
      );

      const weeklyWithNull = await fx.schedule(room.roomUid, {
        frequency: 'WEEKLY',
        daysOfWeek: null,
      });
      t.status(
        'a WEEKLY schedule with null daysOfWeek is refused 400',
        weeklyWithNull,
        400,
      );

      // The DB CHECK uses array_length(), which is NULL for an empty array and
      // therefore passes; the service has to catch [] itself.
      const weeklyWithEmpty = await fx.schedule(room.roomUid, {
        frequency: 'WEEKLY',
        daysOfWeek: [],
      });
      t.status(
        'a WEEKLY schedule with an EMPTY daysOfWeek is refused 400',
        weeklyWithEmpty,
        400,
      );

      const pastStart = await fx.schedule(room.roomUid, {
        activeStart: new Date(Date.now() - 60_000).toISOString(),
      });
      t.status(
        'a schedule whose activeStart is in the past is refused 422',
        pastStart,
        422,
        'INVALID_ACTIVE_START',
      );

      const backwards = await fx.schedule(room.roomUid, {
        activeStart: new Date(Date.now() + 2 * DAY_MS).toISOString(),
        activeEnd: new Date(Date.now() + DAY_MS).toISOString(),
      });
      t.ok(
        'a schedule whose activeEnd precedes activeStart is refused 4xx',
        backwards.status >= 400 && backwards.status < 500,
        `${backwards.status} ${backwards.body?.code ?? ''}`,
      );

      const auto = await fx.room('freq-validation-window', { auto: true });
      const emptyDays = await fx.window(auto.roomUid, { daysOfWeek: [] });
      t.status(
        'an auto-session window with an empty daysOfWeek is refused 400 by the schema',
        emptyDays,
        400,
        'VALIDATION_ERROR',
      );
      const windowBackwards = await fx.window(auto.roomUid, {
        activeStart: new Date(Date.now() + 2 * DAY_MS).toISOString(),
        activeEnd: new Date(Date.now() + DAY_MS).toISOString(),
      });
      t.status(
        'and one whose activeEnd precedes activeStart is refused 422',
        windowBackwards,
        422,
        'INVALID_ACTIVE_END',
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function selectChecks(args) {
  return CHECKS.filter((check) => {
    if (args.only.length && !args.only.some((s) => check.name.includes(s))) {
      return false;
    }
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (...m) => {
    if (!args.json) console.log(...m);
  };

  if (args.list) {
    for (const check of CHECKS) {
      const tags = check.tags?.length ? ` [${check.tags.join(',')}]` : '';
      console.log(`${check.group.padEnd(22)} ${check.name}${tags}`);
    }
    return 0;
  }

  const { env, path: envPath } = loadDeploymentEnv(args.envFile);
  const adminKey =
    process.env.SESSION_MANAGER_API_KEY || env.SESSION_MANAGER_API_KEY;
  if (!adminKey) throw new Error(`${envPath} has no SESSION_MANAGER_API_KEY.`);
  log(`--- keys from ${envPath}; base url ${args.baseUrl}`);

  const api = createApi(args.baseUrl, adminKey);
  const stamp = `scc-${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const fx = new Fixtures(api, stamp);
  log(`--- fixtures named ${stamp}-*`);

  let chunks = null;
  const wantsStream =
    args.stream && selectChecks(args).some((c) => c.tags?.includes('stream'));
  if (wantsStream) {
    chunks = sliceIntoChunks(decodeWav(readFileSync(WAV)), CHUNK_MS);
  }

  const ctx = { api, fx, baseUrl: args.baseUrl, chunks };
  const results = [];

  try {
    for (const check of selectChecks(args)) {
      if (check.tags?.includes('slow') && args.quick) {
        results.push({ ...check, skipped: '--quick', assertions: [] });
        log(`SKIP ${check.name} (--quick)`);
        continue;
      }
      if (check.tags?.includes('stream') && !args.stream) {
        results.push({ ...check, skipped: '--no-stream', assertions: [] });
        log(`SKIP ${check.name} (--no-stream)`);
        continue;
      }

      const t = new Recorder(check.name);
      const startedAt = Date.now();
      let error = null;
      let skipped = null;
      try {
        const outcome = await check.run(t, ctx);
        if (outcome?.skipped) skipped = outcome.skipped;
      } catch (err) {
        error = err instanceof Error ? (err.stack ?? err.message) : String(err);
      }
      const entry = {
        group: check.group,
        name: check.name,
        tags: check.tags ?? [],
        ms: Date.now() - startedAt,
        assertions: t.assertions,
        error,
        skipped,
      };
      results.push(entry);

      const failed = entry.assertions.filter((a) => !a.ok).length;
      const verdict = error
        ? 'ERROR'
        : skipped
          ? 'SKIP'
          : failed
            ? 'FAIL'
            : 'PASS';
      log(
        `${verdict.padEnd(5)} ${check.name} ` +
          `(${entry.assertions.length} assertions, ${Math.round(entry.ms / 1000)}s)`,
      );
      if (skipped) log(`      ${skipped}`);
    }
  } finally {
    if (args.keep) {
      log(
        `--- --keep: left ${fx.rooms.length} room(s), ${fx.devices.length} device(s)`,
      );
    } else {
      log('--- cleaning up');
      await fx.teardown(log);
    }
  }

  // ---- Report ----
  const allAssertions = results.flatMap((r) =>
    r.assertions.map((a) => ({ ...a, check: r.name })),
  );
  const failures = allAssertions.filter((a) => !a.ok);
  const pinned = allAssertions.filter((a) => a.ok && a.pins);
  const errored = results.filter((r) => r.error);
  const ok = failures.length === 0 && errored.length === 0;

  const result = {
    ok,
    stamp,
    baseUrl: args.baseUrl,
    counts: {
      checks: results.length,
      skipped: results.filter((r) => r.skipped).length,
      assertions: allAssertions.length,
      failed: failures.length,
      pinsQuestionableBehaviour: pinned.length,
      errored: errored.length,
    },
    checks: results,
    failures: failures.map((f) => `${f.check}: ${f.name} (${f.detail})`),
    questionable: pinned.map((p) => `${p.pins} ${p.check}: ${p.name}`),
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return ok ? 0 : 1;
  }

  console.log('\n=== RESULT ===');
  let group = null;
  for (const check of results) {
    if (check.group !== group) {
      group = check.group;
      console.log(`\n-- ${group} --`);
    }
    if (check.skipped) {
      console.log(`  SKIP  ${check.name}`);
      console.log(`        ${check.skipped}`);
      continue;
    }
    if (check.error) {
      console.log(`  ERROR ${check.name}`);
      console.log(`        ${check.error.split('\n')[0]}`);
    }
    for (const a of check.assertions) {
      const label = a.ok ? (a.pins ? `PASS (pins ${a.pins})` : 'PASS') : 'FAIL';
      console.log(`  [${label}] ${a.name}`);
      if (!a.ok || a.pins) console.log(`         ${a.detail}`);
    }
  }

  console.log(
    `\n${result.counts.assertions} assertions in ${result.counts.checks} checks ` +
      `(${result.counts.skipped} skipped); ${result.counts.failed} failed, ` +
      `${result.counts.pinsQuestionableBehaviour} pin known-questionable behaviour.`,
  );
  if (pinned.length) {
    console.log(
      '\nAssertions marked "pins" encode behaviour that is currently wrong or\n' +
        'surprising. They pass on purpose so a real regression stands out; each is\n' +
        'documented in tools/session-corner-cases/README.md:',
    );
    for (const p of new Set(result.questionable)) console.log(`  - ${p}`);
  }
  if (errored.length) {
    console.log('\nCHECKS THAT THREW:');
    for (const e of errored) console.log(`  - ${e.name}: ${e.error}`);
  }
  console.log(ok ? '\nPASS' : `\nFAIL\n - ${result.failures.join('\n - ')}`);
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    process.exit(2);
  });
