#!/usr/bin/env node
/**
 * Full Pipeline Integration Test:
 *   Session Manager → Node Server → Transcription Service
 *
 * Tests the complete audio-to-transcript flow:
 *   1. Create session + tokens via Session Manager
 *   2. Connect subscriber (student) to Node Server
 *   3. Connect audio source (kiosk) to Node Server
 *   4. Send audio data through the source
 *   5. Verify subscriber receives transcription results
 *
 * Prerequisites:
 *   - Session Manager running on :8000
 *   - Node Server running on :8001 (with TRANSCRIPTION_SERVICE_URL matching TS port)
 *   - Transcription Service running on the configured port (e.g. :8003)
 *   - All services share matching secrets (JWT_SECRET, TRANSCRIPTION_API_KEY)
 *
 * Usage:
 *   node test-full-pipeline.mjs
 */

import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

const SM_URL = 'http://localhost:8000';
const NS_URL = 'http://localhost:8001';
const TS_URL = 'http://localhost:8003';
const AUDIO_SOURCE_SECRET = 'integration-test-secret-key-min-16';

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`${label}`);
        passed++;
    } else {
        console.log(`${label}`);
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
        setTimeout(() => reject(new Error('WS connection timeout')), 5000);
    });
}

function closeWS(ws) {
    return new Promise((resolve) => {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
        }
        ws.on('close', resolve);
        ws.close();
        setTimeout(resolve, 2000); // fallback timeout
    });
}

function collectMessages(ws, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const messages = [];
        const handler = (data) => {
            try {
                const parsed = JSON.parse(data.toString());
                messages.push(parsed);
            } catch {
                messages.push({ raw: data.toString() });
            }
        };
        ws.on('message', handler);
        setTimeout(() => {
            ws.off('message', handler);
            resolve(messages);
        }, timeoutMs);
    });
}

/**
 * Generate a WAV-formatted audio buffer (PCM16, mono)
 * The transcription service's AudioDecoder uses soundfile which requires
 * a proper container format (WAV), not raw PCM bytes.
 */
function generateTestAudio(durationMs = 500, sampleRate = 16000, numChannels = 1) {
    const numSamples = Math.floor((sampleRate * durationMs) / 1000);
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const dataSize = numSamples * numChannels * bytesPerSample;
    const headerSize = 44;
    const buffer = Buffer.alloc(headerSize + dataSize);

    // WAV RIFF header
    buffer.write('RIFF', 0);                              // ChunkID
    buffer.writeUInt32LE(36 + dataSize, 4);               // ChunkSize
    buffer.write('WAVE', 8);                              // Format
    buffer.write('fmt ', 12);                             // Subchunk1ID
    buffer.writeUInt32LE(16, 16);                         // Subchunk1Size (PCM)
    buffer.writeUInt16LE(1, 20);                          // AudioFormat (1 = PCM)
    buffer.writeUInt16LE(numChannels, 22);                // NumChannels
    buffer.writeUInt32LE(sampleRate, 24);                 // SampleRate
    buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28); // ByteRate
    buffer.writeUInt16LE(numChannels * bytesPerSample, 32);             // BlockAlign
    buffer.writeUInt16LE(bitsPerSample, 34);              // BitsPerSample
    buffer.write('data', 36);                             // Subchunk2ID
    buffer.writeUInt32LE(dataSize, 40);                   // Subchunk2Size

    // PCM audio data — generate a low-frequency tone instead of noise
    // A tone is more reliably detected than random noise
    const frequency = 440; // Hz (A4 note)
    const amplitude = 3000; // ~10% of int16 max
    for (let i = 0; i < numSamples; i++) {
        const sample = Math.floor(amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate));
        buffer.writeInt16LE(sample, headerSize + i * bytesPerSample);
    }
    return buffer;
}

// ─────────────────────────────────────────────────────────
console.log('\nFull Pipeline Test: Session Manager → Node Server → Transcription Service\n');

let subscriberWs = null;
let sourceWs = null;

try {
    // ── Step 1: Health checks ──
    console.log('Step 1: Health checks');

    const smHealth = await httpGet(`${SM_URL}/healthcheck`);
    assert(smHealth.status === 200, `Session Manager healthy (${smHealth.status})`);

    const nsHealth = await httpGet(`${NS_URL}/health`);
    assert(nsHealth.status === 200, `Node Server healthy (${nsHealth.status})`);

    let tsHealthy = false;
    try {
        const tsHealth = await httpGet(`${TS_URL}/healthcheck`);
        assert(tsHealth.status === 200, `Transcription Service healthy (${tsHealth.status})`);
        log('TS response', tsHealth.data);
        tsHealthy = true;
    } catch (err) {
        assert(false, `Transcription Service unreachable at ${TS_URL}: ${err.message}`);
    }

    if (!tsHealthy) {
        console.log('\nTranscription Service is not running — skipping pipeline test');
        console.log('  Start it with: cd transcription_service && ./run.sh');
        process.exit(1);
    }

    // ── Step 2: Create session + tokens ──
    console.log('\nStep 2: Create session');
    const createRes = await httpPost(`${SM_URL}/api/v1/session/create`, {
        sessionLength: 3600,
        audioSourceSecret: AUDIO_SOURCE_SECRET,
        enableJoinCode: true,
        maxClients: 0,
    });
    assert(createRes.status === 200, `Session created (${createRes.status})`);
    const { sessionId, joinCode } = createRes.data;
    log('Session', { sessionId, joinCode, expiresAt: createRes.data.expiresAt });

    // Create room with transcription config on node-server
    console.log('\n Creating room with transcription config on node-server...');
    const createRoomRes = await httpPost(`${NS_URL}/rooms`, {
        sessionId,
        transcriptionConfig: {
            providerKey: 'whisper',
            useSsl: false,
            sampleRate: 16000,
            numChannels: 1,
        },
    });
    assert(createRoomRes.status === 201, `Room created with config (${createRoomRes.status})`);
    log('Room config', createRoomRes.data.transcriptionSessionConfig);

    console.log('\nStep 3: Get tokens');
    const sourceTokenRes = await httpPost(`${SM_URL}/api/v1/session/token`, {
        sessionId,
        audioSourceSecret: AUDIO_SOURCE_SECRET,
        scope: 'source',
    });
    assert(sourceTokenRes.status === 200, `Source token created`);
    const sourceToken = sourceTokenRes.data.token;

    const sinkTokenRes = await httpPost(`${SM_URL}/api/v1/session/token`, {
        joinCode,
        scope: 'sink',
    });
    assert(sinkTokenRes.status === 200, `Sink token created`);
    const sinkToken = sinkTokenRes.data.token;

    // ── Step 4: Connect subscriber first ──
    console.log('\nStep 4: Connect subscriber (student)');
    const subUrl = `ws://localhost:8001/transcription/${sessionId}?token=${sinkToken}`;
    console.log(` ${subUrl.substring(0, 65)}...`);
    subscriberWs = await connectWS(subUrl);
    assert(true, 'Subscriber connected');

    // ── Step 5: Connect audio source ──
    console.log('\nStep 5: Connect audio source (kiosk)');
    const srcUrl = `ws://localhost:8001/audio/${sessionId}?token=${sourceToken}`;
    console.log(`${srcUrl.substring(0, 65)}...`);
    sourceWs = await connectWS(srcUrl);
    assert(true, 'Audio source connected');

    // ── Step 6: Verify room state ──
    console.log('\nStep 6: Verify room state');
    // Wait for transcription client to connect (model loading can take 30s+)
    console.log(' Waiting for transcription service to connect (model may need to load)...');
    await new Promise((r) => setTimeout(r, 3000));

    const roomInfo = await httpGet(`${NS_URL}/rooms/${sessionId}`);
    assert(roomInfo.status === 200, `Room exists`);
    assert(roomInfo.data.hasSource === true, `Room has audio source`);
    assert(roomInfo.data.subscriberCount >= 1, `Room has ${roomInfo.data.subscriberCount} subscriber(s)`);
    assert(roomInfo.data.transcriptionConnected === true, `Transcription service connected`);
    log('Room state', roomInfo.data);

    if (!roomInfo.data.transcriptionConnected) {
        console.log('\nTranscription service not connected to room.');
        console.log('  Check node-server .env: TRANSCRIPTION_SERVICE_URL must match the TS port');
        console.log(`  Currently: TRANSCRIPTION_SERVICE_URL should be localhost:8003`);
    }

    // ── Step 7: Send audio and capture transcriptions ──
    console.log('\nStep 7: Send audio and live transcription\n');

    // Load real audio file (shrek_16k.wav) or fall back to generated audio
    const wavPath = path.resolve('shrek_16k.wav');
    let audioChunks;
    if (fs.existsSync(wavPath)) {
        console.log(` Loading real audio: ${wavPath}`);
        const wavBuf = fs.readFileSync(wavPath);
        const sampleRate = wavBuf.readUInt32LE(24);
        const bitsPerSample = wavBuf.readUInt16LE(34);
        const numChannels = wavBuf.readUInt16LE(22);
        const dataStart = wavBuf.indexOf(Buffer.from('data')) + 8;
        const pcmData = wavBuf.subarray(dataStart);
        const bytesPerSample = bitsPerSample / 8;
        const bytesPerSecond = sampleRate * numChannels * bytesPerSample;
        const chunkDurationMs = 500;
        const chunkBytes = Math.floor((bytesPerSecond * chunkDurationMs) / 1000);

        audioChunks = [];
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
            audioChunks.push(chunk);
        }
        console.log(` ${audioChunks.length} chunks (~${chunkDurationMs}ms each)\n`);
    } else {
        console.log('No shrek_16k.wav found, using generated tone\n');
        audioChunks = Array(5).fill(generateTestAudio(500, 16000));
    }

    // Set up real-time transcription display
    let messageCount = 0;
    let finalizedText = '';  // all finalized transcript lines
    let currentIpText = '';  // current in-progress text (gets overwritten)
    let lastIpLineLen = 0;  // track length for clearing

    const transcriptionDone = new Promise((resolve) => {
        const handler = (data) => {
            try {
                const msg = JSON.parse(data.toString());
                messageCount++;
                const text = Array.isArray(msg.text) ? msg.text.join('') : String(msg.text);

                if (msg.type === 'ip_transcript') {
                    // Overwrite current line with in-progress text
                    currentIpText = text;
                    const display = `  ${currentIpText}`;
                    process.stdout.write(`\r${' '.repeat(lastIpLineLen)}\r`); // clear previous
                    process.stdout.write(display);
                    lastIpLineLen = display.length;
                } else if (msg.type === 'final_transcript') {
                    // Clear the IP line, print final, move to new line
                    process.stdout.write(`\r${' '.repeat(lastIpLineLen)}\r`);
                    console.log(` ${text}`);
                    finalizedText += text;
                    currentIpText = '';
                    lastIpLineLen = 0;
                }
            } catch { /* ignore parse errors */ }
        };
        subscriberWs.on('message', handler);

        // Resolve after timeout (cleanup handled outside)
        setTimeout(() => {
            subscriberWs.off('message', handler);
            // Clear any lingering IP text
            if (lastIpLineLen > 0) {
                process.stdout.write(`\r${' '.repeat(lastIpLineLen)}\r`);
            }
            resolve();
        }, 45000);
    });

    // Send audio chunks while transcriptions stream in
    for (let i = 0; i < audioChunks.length; i++) {
        if (sourceWs.readyState === WebSocket.OPEN) {
            sourceWs.send(audioChunks[i]);
        }
        await new Promise((r) => setTimeout(r, 600));
    }

    // Wait for remaining transcriptions to arrive
    console.log('\n Audio sent, waiting for final transcriptions...');
    await new Promise((r) => setTimeout(r, 10000));

    // Stop the listener
    subscriberWs.removeAllListeners('message');

    console.log(`\n Received ${messageCount} transcription message(s)`);

    if (messageCount > 0) {
        assert(true, `Received ${messageCount} transcription message(s)`);
        assert(finalizedText.length > 0, `Got finalized text: "${finalizedText.trim().substring(0, 80)}..."`);
    } else {
        assert(false, 'No transcription messages received');
        console.log('    Possible causes:');
        console.log('  - Transcription service may not have connected');
        console.log('  - TRANSCRIPTION_SERVICE_URL mismatch in node-server .env');
        console.log('  - TRANSCRIPTION_API_KEY mismatch between node-server and TS');
    }

    // ── Step 8: Disconnect and verify cleanup ──
    console.log('\nStep 8: Disconnect and verify cleanup');
    console.log('  Closing connections...');
    if (sourceWs) await closeWS(sourceWs);
    console.log('  ↳ Source disconnected');
    if (subscriberWs) await closeWS(subscriberWs);
    console.log('  ↳ Subscriber disconnected');
    sourceWs = null;
    subscriberWs = null;

    await new Promise((r) => setTimeout(r, 1000));

    const roomsFinal = await httpGet(`${NS_URL}/rooms`);
    assert(roomsFinal.data.count === 0, `Room cleaned up after disconnect (count=${roomsFinal.data.count})`);
    log('GET /rooms (after cleanup)', roomsFinal.data);

} catch (err) {
    console.error('\n Unexpected error:', err);
    failed++;
} finally {
    // Ensure connections are cleaned up
    if (sourceWs) try { sourceWs.close(); } catch { }
    if (subscriberWs) try { subscriberWs.close(); } catch { }
}

// ── Summary ──
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? ' All tests passed!' : '  Some tests failed');
process.exit(failed > 0 ? 1 : 0);
