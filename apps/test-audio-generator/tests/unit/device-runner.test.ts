import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  FAULT_PARAM_DEFAULTS,
  FaultEngine,
  type FaultParams,
  GOOD_PARAM_DEFAULTS,
  GoodEngine,
  type GoodParams,
  clampFaultParams,
  clampGoodParams,
  createSeededRng,
} from '@scribear/test-audio-source';

import { DeviceRunner } from '#src/server/shared/devices/device-runner.js';
import { fakeClips, fakeDeviceAuth, takeStreams } from '#tests/utils/fakes.js';
import { silentLogger } from '#tests/utils/silent-logger.js';

// Replaces only the streaming engine; every DSP function, engine and clamp
// below is the real one, because those are what the parameters have to reach.
vi.mock('@scribear/test-audio-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@scribear/test-audio-source')>()),
  TestAudioStream: (await import('#tests/utils/fakes.js')).FakeStream,
}));

/**
 * The run manager's contract (PLAN-TestAudioDevices §6, "Unit, run manager").
 *
 * `TestAudioStream` is faked here, not the sockets: what is under test is who
 * may start, when a run ends and what is reported, none of which involves a
 * wire. The streaming itself is the library's, and is tested there.
 */

function goodRunner(
  options: { configured?: boolean; maxDurationSec?: number } = {},
) {
  return new DeviceRunner<GoodParams>({
    deviceId: 'good',
    engine: new GoodEngine(GOOD_PARAM_DEFAULTS, createSeededRng(1)),
    clamp: clampGoodParams,
    resolveClip: (params) => params.clip,
    auth: (options.configured ?? true) ? fakeDeviceAuth() : null,
    clips: fakeClips(),
    config: {
      stream: { nodeServerBaseUrl: 'http://node-server', upstreamWaitMs: 100 },
      maxDurationSec: options.maxDurationSec ?? 1800,
    },
    logger: silentLogger(),
  });
}

function faultRunner() {
  return new DeviceRunner<FaultParams>({
    deviceId: 'fault',
    engine: new FaultEngine(FAULT_PARAM_DEFAULTS, createSeededRng(2)),
    clamp: clampFaultParams,
    resolveClip: () => 'harvard',
    auth: fakeDeviceAuth(),
    clips: fakeClips(),
    config: {
      stream: { nodeServerBaseUrl: 'http://node-server', upstreamWaitMs: 100 },
      maxDurationSec: 1800,
    },
    logger: silentLogger(),
  });
}

/** Lets the microtask queue drain so a backgrounded `_execute` reaches its run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('DeviceRunner', () => {
  beforeEach(() => {
    takeStreams();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('an unconfigured device', (it) => {
    it('reports configured:false and refuses to start', () => {
      // Arrange — no device token, which is the default for a deployment that
      // never provisioned these devices.
      const runner = goodRunner({ configured: false });

      // Assert — the panel must render it as a disabled card, not an error.
      expect(runner.snapshot().configured).toBe(false);
      expect(runner.snapshot().state).toBe('idle');

      // Act + Assert
      expect(() => runner.start({}, 60)).toThrow(/No credential is configured/);
      expect(runner.running).toBe(false);
    });

    it('refuses with 422 DEVICE_NOT_CONFIGURED, which the BFF passes through', () => {
      // Arrange
      const runner = goodRunner({ configured: false });

      // Act
      let thrown: unknown;
      try {
        runner.start({}, 60);
      } catch (err) {
        thrown = err;
      }

      // Assert — a 5xx would be flattened to UPSTREAM_ERROR by the gateway and
      // the operator would never learn which of the two devices is missing.
      expect(thrown).toMatchObject({
        statusCode: 422,
        code: 'DEVICE_NOT_CONFIGURED',
      });
    });
  });

  describe('start', (it) => {
    it('claims the device synchronously, so a second start is a 409', async () => {
      // Arrange
      const runner = goodRunner();

      // Act — the two calls that a double-click produces, with no await in
      // between. The clip load is async, so a check that awaited anything
      // before claiming would let both through.
      runner.start({}, 60);
      let thrown: unknown;
      try {
        runner.start({}, 60);
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toMatchObject({ statusCode: 409, code: 'DEVICE_BUSY' });
      await settle();
      expect(takeStreams()).toHaveLength(1);
    });

    it('rejects a duration over the cap with 422, naming the cap', () => {
      // Arrange — the authoritative cap lives here, not in admin-server's
      // schema, so that a deployment lowering it is obeyed.
      const runner = goodRunner({ maxDurationSec: 120 });

      // Act
      let thrown: unknown;
      try {
        runner.start({}, 121);
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toMatchObject({
        statusCode: 422,
        code: 'DURATION_TOO_LONG',
        details: { maxDurationSec: 120 },
      });
      expect(thrown).toMatchObject({ message: /120s/ });
    });

    it('reports connecting until the first frame, then streaming', async () => {
      // Arrange
      const runner = goodRunner();

      // Act
      const started = runner.start({}, 60);
      await settle();
      const [stream] = takeStreams();

      // Assert — the two states differ by exactly one observable, and every
      // provisioning failure lives in the `connecting` window.
      expect(started.state).toBe('connecting');
      expect(runner.snapshot().state).toBe('connecting');

      // Act — a frame reaches the wire.
      stream?.emitFrames(3);

      // Assert
      expect(runner.snapshot().state).toBe('streaming');
      expect(runner.snapshot().framesSent).toBe(3);
    });

    it("merges the requested knobs over the device's current ones", () => {
      // Arrange
      const runner = goodRunner();
      runner.updateParams({ noiseType: 'brown' });

      // Act — a start naming only the gain must not silently reset the noise
      // the operator set a moment earlier.
      const state = runner.start({ gainDb: -12 }, 60);

      // Assert
      expect(state.params).toMatchObject({
        gainDb: -12,
        noiseType: 'brown',
        clip: 'harvard',
      });
    });

    it('clamps an out-of-range knob rather than trusting the caller', () => {
      // Arrange — the schema states the bounds, but the engine enforces them:
      // anything that reached here another way must still be in range.
      const runner = faultRunner();

      // Act
      const state = runner.updateParams({ speedup: 99, dropPct: -5 });

      // Assert
      expect(state.params).toMatchObject({ speedup: 3, dropPct: 0 });
    });
  });

  describe('auto-stop', (it) => {
    it('fires at durationSec with no further instruction', async () => {
      // Arrange — the point of the cap: a forgotten device must not stream into
      // a room overnight, and nothing external is going to tell it to stop.
      vi.useFakeTimers();
      const runner = goodRunner();

      // Act
      runner.start({}, 60);
      await settle();
      const [stream] = takeStreams();
      expect(stream?.stopped).toBe(false);

      vi.advanceTimersByTime(60_000);

      // Assert
      expect(stream?.stopped).toBe(true);
    });

    it('passes the same deadline to the stream, so the run ends even if the timer never fires', async () => {
      // Arrange — belt and braces. The send loop checks the deadline every
      // chunk, so the run is bounded by the clock rather than by a timer that a
      // paused event loop could delay.
      const runner = goodRunner();
      const before = Date.now();

      // Act
      runner.start({}, 45);
      await settle();
      const [stream] = takeStreams();

      // Assert
      expect(stream?.deadlineMs).toBeGreaterThanOrEqual(before + 45_000);
      expect(stream?.deadlineMs).toBeLessThanOrEqual(Date.now() + 45_000);
    });

    it('returns the device to idle once the run ends', async () => {
      // Arrange
      const runner = goodRunner();
      runner.start({}, 60);
      await settle();
      const [stream] = takeStreams();

      // Act
      stream?.emitFrames(5);
      stream?.finish(null);
      await settle();

      // Assert — the counters survive the run: the operator's run just ended
      // and "how many transcripts came back" is the question they are holding.
      const state = runner.snapshot();
      expect(state.state).toBe('idle');
      expect(state.framesSent).toBe(5);
      expect(state.error).toBeNull();
      expect(runner.running).toBe(false);
    });

    it('reports a failed run as error, and the next start clears it', async () => {
      // Arrange
      const runner = goodRunner();
      runner.start({}, 60);
      await settle();
      const [first] = takeStreams();

      // Act
      first?.finish("No session is currently active in this device's room.");
      await settle();

      // Assert
      expect(runner.snapshot().state).toBe('error');
      expect(runner.snapshot().error).toMatch(/No session/);

      // Act — a start on an errored device is allowed; it is not running.
      runner.start({}, 60);

      // Assert
      expect(runner.snapshot().error).toBeNull();
      expect(runner.snapshot().state).toBe('connecting');
    });
  });

  describe('stop', (it) => {
    it('stops a running device and waits for it to leave the audio path', async () => {
      // Arrange
      const runner = goodRunner();
      runner.start({}, 600);
      await settle();
      const [stream] = takeStreams();

      // Act
      const stopping = runner.stop();
      stream?.finish(null);
      const state = await stopping;

      // Assert — the answer describes a device that has actually stopped, not
      // one that is about to.
      expect(stream?.stopped).toBe(true);
      expect(state.state).toBe('idle');
      expect(runner.running).toBe(false);
    });

    it('is idempotent on an idle device rather than a 409', async () => {
      // Arrange — stop is the operator's remedy for a device in an unexpected
      // state; a stop that errored would take the remedy away.
      const runner = goodRunner();

      // Act
      const state = await runner.stop();

      // Assert
      expect(state.state).toBe('idle');
    });

    it('clears a recorded error, so the operator can acknowledge a failure', async () => {
      // Arrange
      const runner = goodRunner();
      runner.start({}, 60);
      await settle();
      takeStreams()[0]?.finish('boom');
      await settle();
      expect(runner.snapshot().state).toBe('error');

      // Act
      const state = await runner.stop();

      // Assert
      expect(state.state).toBe('idle');
      expect(state.error).toBeNull();
    });

    it('is honoured when it arrives while the clip is still loading', async () => {
      // Arrange — `TestAudioStream.stop()` resets its own flag at the top of
      // `run()`, so a stop during the load would otherwise be forgotten the
      // moment the stream started.
      const clips = fakeClips({ block: true });
      const runner = new DeviceRunner<GoodParams>({
        deviceId: 'good',
        engine: new GoodEngine(GOOD_PARAM_DEFAULTS, createSeededRng(1)),
        clamp: clampGoodParams,
        resolveClip: (params) => params.clip,
        auth: fakeDeviceAuth(),
        clips,
        config: {
          stream: { nodeServerBaseUrl: 'http://n', upstreamWaitMs: 100 },
          maxDurationSec: 1800,
        },
        logger: silentLogger(),
      });

      // Act
      runner.start({}, 600);
      const stopping = runner.stop();
      clips.release();
      await stopping;

      // Assert — the stream was constructed but never run.
      const streams = takeStreams();
      expect(streams).toHaveLength(1);
      expect(streams[0]?.ran).toBe(false);
      expect(runner.running).toBe(false);
    });
  });

  describe('retune', (it) => {
    it('applies to a running device without restarting the stream', async () => {
      // Arrange — the whole point of the feature: turn a knob, watch a meter
      // move. A restart would drop the session and lose what was being watched.
      const runner = goodRunner();
      runner.start({}, 600);
      await settle();
      const streamsBefore = takeStreams();

      // Act
      const state = runner.updateParams({ gainDb: -20 });

      // Assert
      expect(state.params).toMatchObject({ gainDb: -20 });
      expect(state.state).toBe('connecting');
      expect(streamsBefore[0]?.stopped).toBe(false);
      // No new stream was constructed.
      expect(takeStreams()).toHaveLength(0);
    });

    it('updates the pending params of an idle device', () => {
      // Arrange
      const runner = faultRunner();

      // Act
      runner.updateParams({ speedup: 2 });

      // Assert — the same call means the same thing in both states, so the
      // SPA's controls do not have to know which one they are in.
      expect(runner.snapshot().params).toMatchObject({ speedup: 2 });
      expect(runner.snapshot().state).toBe('idle');

      // Act — and the pending value is what the next run starts with.
      const started = runner.start({}, 60);

      // Assert
      expect(started.params).toMatchObject({ speedup: 2 });
    });
  });

  describe('room name', (it) => {
    it('is surfaced while idle, because the room assignment is the safety boundary', async () => {
      // Arrange — an operator about to point a synthetic source at a live
      // pipeline should be able to read the room off the screen.
      const runner = goodRunner();

      // Act
      await runner.refreshRoom();

      // Assert
      expect(runner.snapshot().roomName).toBe('TEST-AUDIO-GOOD');
    });

    it('keeps the previous answer when session-manager is unreachable', async () => {
      // Arrange
      const auth = fakeDeviceAuth();
      const runner = new DeviceRunner<GoodParams>({
        deviceId: 'good',
        engine: new GoodEngine(GOOD_PARAM_DEFAULTS, createSeededRng(1)),
        clamp: clampGoodParams,
        resolveClip: (params) => params.clip,
        auth,
        clips: fakeClips(),
        config: {
          stream: { nodeServerBaseUrl: 'http://n', upstreamWaitMs: 100 },
          maxDurationSec: 1800,
        },
        logger: silentLogger(),
      });
      await runner.refreshRoom();

      // Act — a momentary blip must not make the panel claim the device has no
      // room, which reads as a provisioning error rather than a network one.
      auth.failRoom = true;
      await runner.refreshRoom();

      // Assert
      expect(runner.snapshot().roomName).toBe('TEST-AUDIO-GOOD');
    });

    it('is null for an unconfigured device and costs no request', async () => {
      // Arrange
      const runner = goodRunner({ configured: false });

      // Act
      await runner.refreshRoom();

      // Assert
      expect(runner.snapshot().roomName).toBeNull();
    });
  });
});
