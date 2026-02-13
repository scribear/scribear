#!/usr/bin/env node
/**
 * Integration test: Session Manager + Node Server
 *
 * Prerequisites:
 *   - Session Manager running on :8000
 *   - Node Server running on :8001
 *   - Both share the same JWT_SECRET
 *
 * Usage:
 *   node test-integration.mjs
 */

import WebSocket from 'ws';

const SM_URL = 'http://localhost:8000';
const NS_URL = 'http://localhost:8001';
const AUDIO_SOURCE_SECRET = 'integration-test-secret-key-min-16';

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  Pass: ${label}`);
        passed++;
    } else {
        console.log(` Fail: ${label}`);
        failed++;
    }
}

function log(label, data) {
    console.log(`  ${label}:`, JSON.stringify(data, null, 4).split('\n').join('\n     '));
}

async function httpPost(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
}

async function httpGet(url) {
    const res = await fetch(url);
    const data = await res.json();
    return { status: res.status, data };
}

function connectWS(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.on('open', () => resolve(ws));
        ws.on('error', (err) => reject(err));
        setTimeout(() => reject(new Error('WS connection timeout')), 5000);
    });
}

function closeWS(ws) {
    return new Promise((resolve) => {
        ws.on('close', resolve);
        ws.close();
    });
}

function waitForMessage(ws, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        ws.once('message', (data) => resolve(data.toString()));
        setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    });
}

// ─────────────────────────────────────────────────────────
console.log('\n Integration Test: Session Manager + Node Server\n');

try {
    // ── Step 1: Health checks ──
    console.log('Step 1: Health checks');
    const smHealth = await httpGet(`${SM_URL}/healthcheck`);
    assert(smHealth.status === 200, `Session Manager healthy (${smHealth.status})`);
    log('SM response', smHealth.data);

    const nsHealth = await httpGet(`${NS_URL}/health`);
    assert(nsHealth.status === 200, `Node Server healthy (${nsHealth.status})`);
    log('NS response', nsHealth.data);

    // ── Step 2: Create session ──
    console.log('\nStep 2: Create session');
    const createBody = {
        sessionLength: 3600,
        audioSourceSecret: AUDIO_SOURCE_SECRET,
        enableJoinCode: true,
        maxClients: 0,
    };
    console.log(` POST ${SM_URL}/api/v1/session/create`);
    log('Request body', createBody);

    const createRes = await httpPost(`${SM_URL}/api/v1/session/create`, createBody);
    assert(createRes.status === 200, `Session created (${createRes.status})`);
    assert(!!createRes.data.sessionId, `Got sessionId: ${createRes.data.sessionId}`);
    assert(!!createRes.data.joinCode, `Got joinCode: ${createRes.data.joinCode}`);
    log('Response', createRes.data);

    const { sessionId, joinCode } = createRes.data;

    // ── Step 3: Get tokens ──
    console.log('\nStep 3: Get tokens');

    console.log(`POST ${SM_URL}/api/v1/session/token (source)`);
    const sourceTokenRes = await httpPost(`${SM_URL}/api/v1/session/token`, {
        sessionId,
        audioSourceSecret: AUDIO_SOURCE_SECRET,
        scope: 'source',
    });
    assert(sourceTokenRes.status === 200, `Source token created (${sourceTokenRes.status})`);
    assert(sourceTokenRes.data.scope === 'source', `Scope is "source"`);
    log('Source token response', {
        scope: sourceTokenRes.data.scope,
        expiresIn: sourceTokenRes.data.expiresIn,
        sessionId: sourceTokenRes.data.sessionId,
        token: sourceTokenRes.data.token?.substring(0, 30) + '...',
    });
    const sourceToken = sourceTokenRes.data.token;

    console.log(`POST ${SM_URL}/api/v1/session/token (sink via joinCode)`);
    const sinkTokenRes = await httpPost(`${SM_URL}/api/v1/session/token`, {
        joinCode,
        scope: 'sink',
    });
    assert(sinkTokenRes.status === 200, `Sink token created (${sinkTokenRes.status})`);
    assert(sinkTokenRes.data.scope === 'sink', `Scope is "sink"`);
    log('Sink token response', {
        scope: sinkTokenRes.data.scope,
        expiresIn: sinkTokenRes.data.expiresIn,
        sessionId: sinkTokenRes.data.sessionId,
        token: sinkTokenRes.data.token?.substring(0, 30) + '...',
    });
    const sinkToken = sinkTokenRes.data.token;

    // ── Step 4: Verify rooms are empty ──
    console.log('\nStep 4: Verify rooms empty');
    const roomsBefore = await httpGet(`${NS_URL}/rooms`);
    assert(roomsBefore.data.count === 0, `No rooms initially (count=${roomsBefore.data.count})`);
    log('GET /rooms', roomsBefore.data);

    // ── Step 4b: Create room with transcription config ──
    console.log('\nStep 4b: Create room with transcription config');
    const createRoomRes = await httpPost(`${NS_URL}/rooms`, {
        sessionId,
        transcriptionConfig: {
            providerKey: 'whisper',
            useSsl: false,
            sampleRate: 16000,
            numChannels: 1,
        },
    });
    assert(createRoomRes.status === 201, `Room created (${createRoomRes.status})`);
    assert(
        createRoomRes.data.transcriptionSessionConfig?.providerKey === 'whisper',
        `Provider key is "whisper"`,
    );
    assert(
        createRoomRes.data.transcriptionSessionConfig?.sampleRate === 16000,
        `Sample rate is 16000`,
    );
    log('POST /rooms response', createRoomRes.data);

    // Verify duplicate creation returns 409
    const dupRes = await httpPost(`${NS_URL}/rooms`, { sessionId });
    assert(dupRes.status === 409, `Duplicate room creation rejected (${dupRes.status})`);

    // ── Step 5: Connect subscriber (sink) ──
    console.log('\nStep 5: Connect subscriber');
    const subscriberUrl = `ws://localhost:8001/transcription/${sessionId}?token=${sinkToken}`;
    console.log(`WS ${subscriberUrl.substring(0, 60)}...`);
    let subscriberWs;
    try {
        subscriberWs = await connectWS(subscriberUrl);
        assert(true, 'Subscriber WebSocket connected');
    } catch (err) {
        assert(false, `Subscriber WS failed: ${err.message}`);
    }

    // ── Step 6: Connect audio source ──
    console.log('\nStep 6: Connect audio source');
    const sourceUrl = `ws://localhost:8001/audio/${sessionId}?token=${sourceToken}`;
    console.log(`WS ${sourceUrl.substring(0, 60)}...`);
    let sourceWs;
    try {
        sourceWs = await connectWS(sourceUrl);
        assert(true, 'Audio source WebSocket connected');
    } catch (err) {
        assert(false, `Audio source WS failed: ${err.message}`);
    }

    // ── Step 7: Verify room exists ──
    console.log('\nStep 7: Verify room created');
    // Small delay to let the server process
    await new Promise((r) => setTimeout(r, 500));

    const roomsAfter = await httpGet(`${NS_URL}/rooms`);
    assert(roomsAfter.data.count > 0, `Room exists (count=${roomsAfter.data.count})`);
    log('GET /rooms', roomsAfter.data);

    // Check specific room info
    console.log(`GET ${NS_URL}/rooms/${sessionId}`);
    const roomInfo = await httpGet(`${NS_URL}/rooms/${sessionId}`);
    if (roomInfo.status === 200) {
        assert(true, `Room info retrieved for ${sessionId}`);
        assert(roomInfo.data.hasSource === true, `Room has audio source`);
        assert(roomInfo.data.subscriberCount >= 1, `Room has ${roomInfo.data.subscriberCount} subscriber(s)`);
        log('Room details', roomInfo.data);
    } else {
        assert(false, `Room info failed (${roomInfo.status})`);
        log('Error response', roomInfo.data);
    }

    // ── Step 8: Test wrong scope rejection ──
    console.log('\nStep 8: Test auth scope enforcement');
    console.log(' Attempting sink token on /audio endpoint (should be rejected)');
    try {
        const badWs = await connectWS(`ws://localhost:8001/audio/${sessionId}?token=${sinkToken}`);
        const closeCode = await new Promise((resolve) => {
            badWs.on('close', (code) => resolve(code));
            setTimeout(() => resolve('timeout'), 3000);
        });
        assert(closeCode === 4003, `Sink token rejected on audio endpoint (close code: ${closeCode})`);
    } catch (err) {
        assert(true, `Sink token rejected on audio endpoint: ${err.message}`);
    }

    // ── Step 9: Test no-token rejection ──
    console.log('\nStep 9: Test missing token rejection');
    console.log('Attempting connection with no token (should get 401)');
    try {
        await connectWS(`ws://localhost:8001/audio/${sessionId}`);
        assert(false, 'Should have rejected missing token');
    } catch (err) {
        assert(true, `Missing token rejected: ${err.message}`);
    }

    // ── Step 10: Disconnect and verify cleanup ──
    console.log('\nStep 10: Disconnect and verify cleanup');
    console.log(' Closing source and subscriber connections...');
    if (sourceWs) await closeWS(sourceWs);
    console.log('  ↳ Source disconnected');
    if (subscriberWs) await closeWS(subscriberWs);
    console.log('  ↳ Subscriber disconnected');
    // Give server time to clean up
    await new Promise((r) => setTimeout(r, 500));

    const roomsFinal = await httpGet(`${NS_URL}/rooms`);
    assert(roomsFinal.data.count === 0, `Room cleaned up after disconnect (count=${roomsFinal.data.count})`);
    log('GET /rooms (after cleanup)', roomsFinal.data);

} catch (err) {
    console.error('\nUnexpected error:', err);
    failed++;
}

// ── Summary ──
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'All tests passed!' : 'Some tests failed');
process.exit(failed > 0 ? 1 : 0);
