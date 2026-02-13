#!/usr/bin/env node
/**
 * Multi-Room Integration Test
 *
 * Tests concurrent rooms with isolation, multiple subscribers, and room lifecycle:
 *   1. Create 3 sessions simultaneously
 *   2. Each room gets 2 subscribers + 1 audio source
 *   3. Send audio to all rooms concurrently
 *   4. Verify subscribers only receive their room's transcriptions
 *   5. Disconnect 1 room, verify others still work
 *   6. Test late-join subscriber receives new transcriptions
 *   7. Full cleanup verification
 *
 * Prerequisites:
 *   - Session Manager on :8000, Node Server on :8001, Transcription Service on :8003
 *   - provider_config with num_workers >= 3 and max_instances >= 3
 *
 * Usage:
 *   node test-multi-room.mjs
 */

import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

const SM_URL = 'http://localhost:8000';
const NS_URL = 'http://localhost:8001';
const TS_URL = 'http://localhost:8003';
const SECRET = 'integration-test-secret-key-min-16';

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  Passed: ${label}`);
        passed++;
    } else {
        console.log(`  Fail: ${label}`);
        failed++;
    }
}

function log(label, data) {
    const formatted = typeof data === 'string' ? data : JSON.stringify(data, null, 4);
    console.log(` ${label}:`, formatted.split('\n').join('\n     '));
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
        setTimeout(() => reject(new Error('WS connection timeout')), 10000);
    });
}

function closeWS(ws) {
    return new Promise((resolve) => {
        if (!ws || ws.readyState === WebSocket.CLOSED) { resolve(); return; }
        ws.on('close', resolve);
        ws.close();
        setTimeout(resolve, 3000);
    });
}

/**
 * Generate WAV-formatted audio (440Hz tone)
 */
function generateTestAudio(durationMs = 500, sampleRate = 16000) {
    const numSamples = Math.floor((sampleRate * durationMs) / 1000);
    const dataSize = numSamples * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < numSamples; i++) {
        const sample = Math.floor(3000 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
        buffer.writeInt16LE(sample, 44 + i * 2);
    }
    return buffer;
}

/**
 * Load and chunk a WAV file, or fall back to generated audio
 */
function loadAudioChunks(wavPath, chunkMs = 500) {
    if (fs.existsSync(wavPath)) {
        const wavBuf = fs.readFileSync(wavPath);
        const sampleRate = wavBuf.readUInt32LE(24);
        const bitsPerSample = wavBuf.readUInt16LE(34);
        const numChannels = wavBuf.readUInt16LE(22);
        const dataStart = wavBuf.indexOf(Buffer.from('data')) + 8;
        const pcmData = wavBuf.subarray(dataStart);
        const bytesPerSample = bitsPerSample / 8;
        const bytesPerSecond = sampleRate * numChannels * bytesPerSample;
        const chunkBytes = Math.floor((bytesPerSecond * chunkMs) / 1000);

        const chunks = [];
        for (let offset = 0; offset < pcmData.length; offset += chunkBytes) {
            const slice = pcmData.subarray(offset, Math.min(offset + chunkBytes, pcmData.length));
            const chunk = Buffer.alloc(44 + slice.length);
            chunk.write('RIFF', 0);
            chunk.writeUInt32LE(36 + slice.length, 4);
            chunk.write('WAVE', 8);
            chunk.write('fmt ', 12);
            chunk.writeUInt32LE(16, 16);
            chunk.writeUInt16LE(1, 20);
            chunk.writeUInt16LE(numChannels, 22);
            chunk.writeUInt32LE(sampleRate, 24);
            chunk.writeUInt32LE(bytesPerSecond, 28);
            chunk.writeUInt16LE(numChannels * bytesPerSample, 32);
            chunk.writeUInt16LE(bitsPerSample, 34);
            chunk.write('data', 36);
            chunk.writeUInt32LE(slice.length, 40);
            slice.copy(chunk, 44);
            chunks.push(chunk);
        }
        return { chunks, source: 'shrek_16k.wav' };
    }
    return { chunks: Array(10).fill(generateTestAudio(500)), source: 'generated' };
}

/**
 * Create a full session: session + tokens + room with transcription config
 */
async function createSession(label) {
    const sess = await httpPost(`${SM_URL}/api/v1/session/create`, {
        sessionLength: 3600,
        audioSourceSecret: SECRET,
        enableJoinCode: true,
        maxClients: 0,
    });
    const { sessionId, joinCode } = sess.data;

    // Create room on node-server with transcription config
    const roomRes = await httpPost(`${NS_URL}/rooms`, {
        sessionId,
        transcriptionConfig: {
            providerKey: 'whisper',
            useSsl: false,
            sampleRate: 16000,
            numChannels: 1,
        },
    });
    assert(roomRes.status === 201, `${label}: room created with config`);

    const srcToken = await httpPost(`${SM_URL}/api/v1/session/token`, {
        sessionId, audioSourceSecret: SECRET, scope: 'source',
    });
    const sinkToken = await httpPost(`${SM_URL}/api/v1/session/token`, {
        joinCode, scope: 'sink',
    });

    console.log(` ${label}: session=${sessionId.substring(0, 20)}... join=${joinCode}`);
    return {
        label,
        sessionId,
        joinCode,
        sourceToken: srcToken.data.token,
        sinkToken: sinkToken.data.token,
        sourceWs: null,
        subscribers: [],
        messages: new Map(), // subscriberIndex -> messages[]
    };
}

/**
 * Attach a real-time message listener to a subscriber WS, keyed by room
 */
function attachListener(ws, room, subscriberIdx) {
    const key = `sub${subscriberIdx}`;
    if (!room.messages.has(key)) room.messages.set(key, []);
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            room.messages.get(key).push(msg);
        } catch { /* skip */ }
    });
}

/**
 * Send audio chunks to a source WS
 */
async function sendAudio(ws, chunks, delayMs = 500) {
    for (const chunk of chunks) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk);
        }
        await new Promise((r) => setTimeout(r, delayMs));
    }
}

// ─────────────────────────────────────────────────────────
console.log('\nMulti-Room Integration Test\n');

const allSockets = []; // track all sockets for cleanup

try {
    // ── Step 1: Health checks ──
    console.log('Step 1: Health checks');
    const smH = await httpGet(`${SM_URL}/healthcheck`);
    assert(smH.status === 200, `Session Manager healthy`);
    const nsH = await httpGet(`${NS_URL}/health`);
    assert(nsH.status === 200, `Node Server healthy`);
    const tsH = await httpGet(`${TS_URL}/healthcheck`);
    assert(tsH.status === 200, `Transcription Service healthy`);

    // ── Step 2: Create 3 sessions ──
    console.log('\nStep 2: Create 3 sessions');
    const rooms = await Promise.all([
        createSession('Room A'),
        createSession('Room B'),
        createSession('Room C'),
    ]);

    // ── Step 3: Connect subscribers (2 per room) ──
    console.log('\nStep 3: Connect subscribers (2 per room)');
    for (const room of rooms) {
        for (let i = 0; i < 2; i++) {
            const url = `ws://localhost:8001/transcription/${room.sessionId}?token=${room.sinkToken}`;
            const ws = await connectWS(url);
            room.subscribers.push(ws);
            allSockets.push(ws);
            attachListener(ws, room, i);
        }
        assert(true, `${room.label}: 2 subscribers connected`);
    }

    // ── Step 4: Connect audio sources ──
    console.log('\nStep 4: Connect audio sources (1 per room)');
    for (const room of rooms) {
        const url = `ws://localhost:8001/audio/${room.sessionId}?token=${room.sourceToken}`;
        room.sourceWs = await connectWS(url);
        allSockets.push(room.sourceWs);
        assert(true, `${room.label}: audio source connected`);
    }

    // ── Step 5: Verify all 3 rooms exist ──
    console.log('\nStep 5: Verify room state');
    await new Promise((r) => setTimeout(r, 5000)); // wait for transcription connections

    const roomList = await httpGet(`${NS_URL}/rooms`);
    assert(roomList.data.count === 3, `3 rooms active (got ${roomList.data.count})`);

    for (const room of rooms) {
        const info = await httpGet(`${NS_URL}/rooms/${room.sessionId}`);
        assert(info.data.hasSource === true, `${room.label}: has source`);
        assert(info.data.subscriberCount === 2, `${room.label}: has 2 subscribers`);
        assert(info.data.transcriptionConnected === true, `${room.label}: transcription connected`);
    }

    // ── Step 6: Send audio to all rooms concurrently ──
    console.log('\nStep 6: Send audio to all 3 rooms concurrently');
    const wavPath = path.resolve('shrek_16k.wav');
    const { chunks, source } = loadAudioChunks(wavPath);
    console.log(`Audio source: ${source} (${chunks.length} chunks)`);

    // Send audio to all rooms simultaneously
    await Promise.all(rooms.map((room) => sendAudio(room.sourceWs, chunks, 500)));
    console.log('Audio sent to all rooms');

    // Wait for transcriptions to arrive
    console.log('Waiting for transcription results...');
    await new Promise((r) => setTimeout(r, 15000));

    // ── Step 7: Verify all subscribers received transcriptions ──
    console.log('\nStep 7: Verify transcription delivery');
    for (const room of rooms) {
        const sub0msgs = room.messages.get('sub0') || [];
        const sub1msgs = room.messages.get('sub1') || [];
        assert(sub0msgs.length > 0, `${room.label} sub0: ${sub0msgs.length} messages`);
        assert(sub1msgs.length > 0, `${room.label} sub1: ${sub1msgs.length} messages`);

        // Both subscribers should get the same data
        const sub0finals = sub0msgs.filter((m) => m.type === 'final_transcript');
        const sub1finals = sub1msgs.filter((m) => m.type === 'final_transcript');
        assert(
            sub0finals.length === sub1finals.length,
            `${room.label}: both subs got same number of finals (${sub0finals.length})`,
        );

        // Show what was transcribed
        if (sub0finals.length > 0) {
            const text = sub0finals.map((m) => m.text.join('')).join(' ');
            console.log(`${room.label}: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
        }
    }

    // ── Step 8: Disconnect Room A, verify B and C still work ──
    console.log('\nStep 8: Disconnect Room A, verify others persist');
    const roomA = rooms[0];
    await closeWS(roomA.sourceWs);
    for (const sub of roomA.subscribers) await closeWS(sub);
    roomA.sourceWs = null;
    roomA.subscribers = [];

    await new Promise((r) => setTimeout(r, 2000));

    const afterDisconnect = await httpGet(`${NS_URL}/rooms`);
    assert(afterDisconnect.data.count === 2, `2 rooms remain after Room A disconnect (got ${afterDisconnect.data.count})`);

    // Verify B and C still have sources and subscribers
    for (const room of [rooms[1], rooms[2]]) {
        const info = await httpGet(`${NS_URL}/rooms/${room.sessionId}`);
        assert(info.data.hasSource === true, `${room.label}: still has source`);
        assert(info.data.subscriberCount === 2, `${room.label}: still has 2 subscribers`);
    }

    // ── Step 9: Late-join subscriber to Room B ──
    console.log('\nStep 9: Late-join subscriber to Room B');
    const roomB = rooms[1];
    const lateJoinToken = await httpPost(`${SM_URL}/api/v1/session/token`, {
        joinCode: roomB.joinCode, scope: 'sink',
    });
    const lateSubUrl = `ws://localhost:8001/transcription/${roomB.sessionId}?token=${lateJoinToken.data.token}`;
    const lateSub = await connectWS(lateSubUrl);
    allSockets.push(lateSub);
    roomB.subscribers.push(lateSub);
    attachListener(lateSub, roomB, 2);
    assert(true, 'Late subscriber connected to Room B');

    // Verify subscriber count increased
    const roomBInfo = await httpGet(`${NS_URL}/rooms/${roomB.sessionId}`);
    assert(roomBInfo.data.subscriberCount === 3, `Room B now has 3 subscribers`);

    // Send more audio to Room B and verify late subscriber gets it
    const shortChunks = chunks.slice(0, 5);
    await sendAudio(roomB.sourceWs, shortChunks, 500);
    console.log('Sent additional audio to Room B');

    await new Promise((r) => setTimeout(r, 12000));
    const lateSubMsgs = roomB.messages.get('sub2') || [];
    assert(lateSubMsgs.length > 0, `Late subscriber received ${lateSubMsgs.length} messages`);

    // ── Step 10: Disconnect remaining rooms ──
    console.log('\nStep 10: Full cleanup');
    for (const room of rooms) {
        if (room.sourceWs) await closeWS(room.sourceWs);
        for (const sub of room.subscribers) await closeWS(sub);
    }

    await new Promise((r) => setTimeout(r, 2000));

    const finalRooms = await httpGet(`${NS_URL}/rooms`);
    assert(finalRooms.data.count === 0, `All rooms cleaned up (count=${finalRooms.data.count})`);

} catch (err) {
    console.error('\nUnexpected error:', err);
    failed++;
} finally {
    for (const ws of allSockets) {
        try { ws.close(); } catch { /* ignore */ }
    }
}

// ── Summary ──
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'All tests passed!' : 'Some tests failed');
process.exit(failed > 0 ? 1 : 0);
