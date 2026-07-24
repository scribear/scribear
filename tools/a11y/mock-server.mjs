/**
 * Mock ScribeAR backend for accessibility / WCAG testing of the frontends.
 *
 * The three webapps are gated behind session/device state that a plain axe crawl
 * can never reach (client = Join-Session modal, kiosk = "Initializing…"/activation,
 * standalone = client-side only). This server fakes just enough of the
 * Session-Manager REST API and the Node-Server transcription WebSocket to get each
 * app *past its lock screen* and, for the client/kiosk, to stream fake live
 * captions — so both automated axe runs (see axe-scan-authed.mjs) and a human with
 * a screen reader / braille display can exercise the real caption UI (the P0
 * `role="log"` live region) without the whole backend + audio pipeline.
 *
 * It is a thin shim: every request it does NOT recognise is reverse-proxied to the
 * already-running deploy_local nginx stack (default https://localhost), so it
 * serves the real, deployed frontend bundles unchanged on a single origin.
 *
 * Usage:
 *   node tools/a11y/mock-server.mjs                # listen :8090, proxy https://localhost
 *   PORT=9000 UPSTREAM=https://localhost node tools/a11y/mock-server.mjs
 *
 * Then open (use 127.0.0.1, NOT localhost, to dodge any HSTS from the https stack):
 *   http://127.0.0.1:8090/client/       -> type ANY join code -> live captions
 *   http://127.0.0.1:8090/kiosk/        -> type ANY activation code -> registered
 *   http://127.0.0.1:8090/standalone/   -> runs client-side (no backend needed)
 *
 * Env knobs:
 *   PORT                 listen port (default 8090)
 *   UPSTREAM             origin to proxy unmatched requests to (default https://localhost)
 *   MOCK_DEVICE_REGISTERED=1   treat the kiosk as already activated (skip the cookie gate)
 *   MOCK_CAPTION_MS      ms between caption ticks (default 1200)
 *   MOCK_NO_CAPTIONS=1   accept the WS but never stream captions (test the empty log region)
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8090);
const UPSTREAM = new URL(process.env.UPSTREAM ?? 'https://localhost');
const CAPTION_MS = Number(process.env.MOCK_CAPTION_MS ?? 1200);
const DEVICE_TOKEN_COOKIE = 'DEVICE_TOKEN';

const SM = '/api/session-manager/v1';
const NS_STREAM = '/api/node-server/v1/transcription-stream/';

const nowIso = () => new Date().toISOString();
const inHour = () => new Date(Date.now() + 3600_000).toISOString();

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function hasDeviceToken(req) {
  if (process.env.MOCK_DEVICE_REGISTERED === '1') return true;
  const cookie = req.headers.cookie ?? '';
  return cookie.split(';').some((c) => c.trim().startsWith(`${DEVICE_TOKEN_COOKIE}=`));
}

// A fake session, minted per join code so the WS URL's sessionUid lines up.
function mintSession() {
  return {
    sessionUid: randomUUID(),
    clientId: randomUUID(),
    sessionToken: `mock.${randomUUID()}`,
    sessionTokenExpiresAt: inHour(),
    sessionRefreshToken: `mock-refresh.${randomUUID()}`,
    scopes: ['session:receive-transcripts'],
  };
}

// ---------------------------------------------------------------------------
// Session-Manager REST mock. Returns true if it handled the request.
// ---------------------------------------------------------------------------
async function handleSessionManager(req, res, path) {
  const route = path.slice(SM.length); // strip base

  // client: unlock the Join-Session modal.
  if (req.method === 'POST' && route === '/session-auth/exchange-join-code') {
    await readBody(req);
    sendJson(res, 200, mintSession());
    return true;
  }
  if (req.method === 'POST' && route === '/session-auth/refresh-session-token') {
    await readBody(req);
    sendJson(res, 200, {
      sessionToken: `mock.${randomUUID()}`,
      sessionTokenExpiresAt: inHour(),
    });
    return true;
  }
  // kiosk source flow.
  if (req.method === 'POST' && route === '/session-auth/exchange-device-token') {
    await readBody(req);
    sendJson(res, 200, {
      sessionToken: `mock.${randomUUID()}`,
      sessionTokenExpiresAt: inHour(),
      scopes: ['session:send-audio'],
    });
    return true;
  }
  if (req.method === 'POST' && route === '/session-auth/fetch-join-code') {
    await readBody(req);
    sendJson(res, 200, {
      current: { joinCode: 'MOCK01', validStart: nowIso(), validEnd: inHour() },
      next: null,
    });
    return true;
  }

  // kiosk: device identity. No cookie -> 401 (shows the activation form);
  // cookie present (after activate-device) -> 200 unassigned device -> IDLE.
  if (req.method === 'GET' && route === '/device-management/get-my-device') {
    if (!hasDeviceToken(req)) {
      sendJson(res, 401, {
        code: 'INVALID_DEVICE_TOKEN',
        message: 'No device token (mock).',
      });
      return true;
    }
    sendJson(res, 200, {
      uid: randomUUID(),
      name: 'Mock Kiosk Device',
      roomUid: null,
      isSource: null,
    });
    return true;
  }
  // kiosk: activation -> mint the HTTP-only DEVICE_TOKEN cookie.
  if (req.method === 'POST' && route === '/device-management/activate-device') {
    await readBody(req);
    sendJson(
      res,
      200,
      { deviceUid: randomUUID() },
      {
        'set-cookie': `${DEVICE_TOKEN_COOKIE}=mock-device-token; Path=/; HttpOnly; SameSite=Lax`,
      },
    );
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Reverse proxy for everything else -> the deployed frontends on UPSTREAM.
// ---------------------------------------------------------------------------
function proxy(req, res) {
  const isHttps = UPSTREAM.protocol === 'https:';
  const doRequest = isHttps ? httpsRequest : httpRequest;
  const headers = { ...req.headers, host: UPSTREAM.host };
  const upstreamReq = doRequest(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || (isHttps ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
      rejectUnauthorized: false, // deploy_local self-signed cert
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers };
      // Never let the browser upgrade our http origin to https.
      delete outHeaders['strict-transport-security'];
      // Keep redirects on the mock origin.
      if (outHeaders.location) {
        outHeaders.location = String(outHeaders.location)
          .replace(UPSTREAM.origin, `http://127.0.0.1:${String(PORT)}`)
          .replace(`https://${UPSTREAM.host}`, `http://127.0.0.1:${String(PORT)}`);
      }
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Mock proxy error reaching ${UPSTREAM.origin}: ${err.message}\n`);
  });
  req.pipe(upstreamReq);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/__mock/health') {
    sendJson(res, 200, { ok: true, upstream: UPSTREAM.origin });
    return;
  }
  if (path.startsWith(SM)) {
    handleSessionManager(req, res, path).then((handled) => {
      if (!handled) {
        sendJson(res, 404, { code: 'MOCK_UNIMPLEMENTED', message: `No mock for ${req.method ?? ''} ${path}` });
      }
    });
    return;
  }
  proxy(req, res);
});

// ---------------------------------------------------------------------------
// Transcription-stream WebSocket mock — stream fake captions.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

// A short scripted "lecture" streamed word-by-word: each sentence grows as an
// interim (inProgress) fragment, then is committed once as a final fragment —
// exactly the interim-churn-then-finalize pattern the role="log" region must
// announce correctly.
const SCRIPT = [
  'Welcome to today’s accessibility demonstration.',
  'These captions are streamed over a mock WebSocket.',
  'Interim words appear first and are hidden from assistive technology.',
  'When a sentence is finalized it is announced exactly once.',
  'A braille display should be able to review the full history.',
];

function fragment(text) {
  return { text: text.split(/(\s+)/).filter(Boolean), starts: null, ends: null };
}

function streamCaptions(ws) {
  ws.send(JSON.stringify({ type: 'sessionStatus', transcriptionServiceConnected: true, sourceDeviceConnected: true }));
  if (process.env.MOCK_NO_CAPTIONS === '1') return;

  let sentence = 0;
  let word = 0;
  const tick = () => {
    if (ws.readyState !== ws.OPEN) return;
    const words = SCRIPT[sentence % SCRIPT.length].split(' ');
    word += 1;
    if (word < words.length) {
      // Growing interim result.
      ws.send(JSON.stringify({ type: 'transcript', final: null, inProgress: fragment(words.slice(0, word).join(' ')) }));
    } else {
      // Finalize the sentence: emit a committed fragment, clear the interim.
      ws.send(JSON.stringify({ type: 'transcript', final: fragment(words.join(' ')), inProgress: null }));
      sentence += 1;
      word = 0;
    }
    timer = setTimeout(tick, CAPTION_MS / 2);
  };
  let timer = setTimeout(tick, CAPTION_MS);
  ws.on('close', () => clearTimeout(timer));
}

wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // ignore audio frames from source clients
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'auth') {
      ws.send(JSON.stringify({ type: 'authOk' }));
      streamCaptions(ws);
    } else if (msg.type === 'timeSyncPing') {
      ws.send(JSON.stringify({ type: 'timeSyncPong', t0: msg.t0, t1: Date.now() }));
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path.startsWith(NS_STREAM)) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy(); // we don't proxy arbitrary websockets
  }
});

server.listen(PORT, () => {
  process.stdout.write(
    `Mock ScribeAR backend on http://127.0.0.1:${String(PORT)} (proxying ${UPSTREAM.origin})\n` +
      `  client:     http://127.0.0.1:${String(PORT)}/client/\n` +
      `  kiosk:      http://127.0.0.1:${String(PORT)}/kiosk/\n` +
      `  standalone: http://127.0.0.1:${String(PORT)}/standalone/\n`,
  );
});
