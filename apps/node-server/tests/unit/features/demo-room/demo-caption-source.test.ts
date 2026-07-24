import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { DemoRoomConfig } from '#src/app-config/app-config.js';
import {
  DemoCaptionSource,
  buildDemoSchedule,
  buildFragment,
} from '#src/server/features/demo-room/demo-caption-source.js';
import { SessionStatusChannel } from '#src/server/features/transcription-stream/events/session-status.events.js';
import {
  TranscriptChannel,
  type TranscriptMessage,
} from '#src/server/features/transcription-stream/events/transcript.events.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const SESSION_UID = 'demo-session-under-test';

describe('buildFragment', (it) => {
  it('splits into space-prefixed word tokens that rejoin to the source text', () => {
    // Act
    const fragment = buildFragment('who are you', 'alice', false, 0, 3);

    // Assert
    expect(fragment.text).toStrictEqual(['who', ' are', ' you']);
    expect(fragment.text.join('')).toBe('who are you');
  });

  it('folds a capitalized speaker label into the first token on a turn start', () => {
    // Act
    const fragment = buildFragment('who are', 'caterpillar', true, 0, 2);

    // Assert - the label rides on the leading token; the wire schema has no
    // speaker field.
    expect(fragment.text[0]).toBe('Caterpillar:');
    expect(fragment.text.join('')).toBe('Caterpillar: who are');
  });

  it('does not prefix a speaker label when the utterance continues a turn', () => {
    // Act
    const fragment = buildFragment('and again', 'caterpillar', false, 0, 2);

    // Assert
    expect(fragment.text[0]).toBe('and');
  });

  it('emits per-token timings within the utterance window, aligned to text', () => {
    // Act
    const fragment = buildFragment('one two', 'alice', false, 4, 6);

    // Assert
    expect(fragment.starts).toStrictEqual([4, 5]);
    expect(fragment.ends).toStrictEqual([5, 6]);
    expect(fragment.starts).toHaveLength(fragment.text.length);
    expect(fragment.ends).toHaveLength(fragment.text.length);
  });
});

describe('buildDemoSchedule', (it) => {
  it('emits interim at the midpoint then final at the end, per utterance', () => {
    // Arrange
    const utterances = [
      {
        start: 0,
        end: 2,
        speaker: 'alice',
        spoken: 'hello there',
        progresstxt: 'hello',
      },
    ];

    // Act
    const { events } = buildDemoSchedule(utterances);

    // Assert
    expect(events).toHaveLength(2);
    expect(events[0]?.atMs).toBe(1000); // midpoint of [0, 2]
    expect(events[0]?.message.inProgress?.text.join('')).toBe('Alice: hello');
    expect(events[0]?.message.final).toBeNull();
    expect(events[1]?.atMs).toBe(2000); // end
    expect(events[1]?.message.final?.text.join('')).toBe('Alice: hello there');
    expect(events[1]?.message.inProgress).toBeNull();
  });

  it('skips the interim caption when progresstxt is empty', () => {
    // Arrange - short utterances (e.g. "No.") carry no interim.
    const utterances = [
      { start: 0, end: 1, speaker: 'alice', spoken: 'No.', progresstxt: '' },
    ];

    // Act
    const { events } = buildDemoSchedule(utterances);

    // Assert - only the final event exists
    expect(events).toHaveLength(1);
    expect(events[0]?.message.final?.text.join('')).toBe('Alice: No.');
  });

  it('prefixes the speaker label only at a change of speaker', () => {
    // Arrange
    const utterances = [
      { start: 0, end: 1, speaker: 'alice', spoken: 'a', progresstxt: '' },
      { start: 1, end: 2, speaker: 'alice', spoken: 'b', progresstxt: '' },
      { start: 2, end: 3, speaker: 'pigeon', spoken: 'c', progresstxt: '' },
    ];

    // Act
    const finals = buildDemoSchedule(utterances).events.map((e) =>
      e.message.final?.text.join(''),
    );

    // Assert
    expect(finals).toStrictEqual(['Alice: a', 'b', 'Pigeon: c']);
  });

  it('orders events by time and derives loop length from the last event', () => {
    // Arrange
    const utterances = [
      { start: 0, end: 2, speaker: 'alice', spoken: 'x', progresstxt: 'x' },
      { start: 3, end: 5, speaker: 'alice', spoken: 'y', progresstxt: 'y' },
    ];

    // Act
    const { events, loopMs } = buildDemoSchedule(utterances);

    // Assert - monotonic non-decreasing atMs; loopMs is last end + tail gap
    const times = events.map((e) => e.atMs);
    expect(times).toStrictEqual([...times].sort((a, b) => a - b));
    expect(loopMs).toBe(5000 + 2000);
  });
});

describe('DemoCaptionSource', () => {
  let bus: EventBusService;
  let orchestrator: { registerSyntheticSession: ReturnType<typeof vi.fn> };
  let transcripts: TranscriptMessage[];
  let statuses: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    bus = new EventBusService(createMockLogger() as never);
    orchestrator = { registerSyntheticSession: vi.fn() };
    transcripts = [];
    statuses = [];
    bus.subscribe(TranscriptChannel, (m) => transcripts.push(m), SESSION_UID);
    bus.subscribe(SessionStatusChannel, (m) => statuses.push(m), SESSION_UID);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSource(enabled: boolean): DemoCaptionSource {
    const config: DemoRoomConfig = { enabled, sessionUid: SESSION_UID };
    return new DemoCaptionSource(
      createMockLogger() as never,
      bus,
      orchestrator as never,
      config,
    );
  }

  describe('when disabled', (it) => {
    it('does nothing: no timer, no status, no captions', () => {
      // Act
      makeSource(false).start();

      // Assert
      expect(vi.getTimerCount()).toBe(0);
      expect(orchestrator.registerSyntheticSession).not.toHaveBeenCalled();
      expect(transcripts).toHaveLength(0);
      expect(statuses).toHaveLength(0);
    });
  });

  describe('when enabled', (it) => {
    it('registers a healthy synthetic status and publishes it once', () => {
      // Act
      makeSource(true).start();

      // Assert
      expect(orchestrator.registerSyntheticSession).toHaveBeenCalledWith(
        SESSION_UID,
        { transcriptionServiceConnected: true, sourceDeviceConnected: true },
      );
      expect(statuses).toStrictEqual([
        { transcriptionServiceConnected: true, sourceDeviceConnected: true },
      ]);
    });

    it('publishes the first caption as an interim with the speaker prefix', () => {
      // Arrange
      makeSource(true).start();

      // Act - the first fixture utterance (Caterpillar "Who are you?") has its
      // interim at its midpoint, 500ms in.
      vi.advanceTimersByTime(600);

      // Assert
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]?.final).toBeNull();
      expect(transcripts[0]?.inProgress?.text[0]).toBe('Caterpillar:');
    });

    it('loops forever: the stream keeps producing captions past one pass', () => {
      // Arrange
      const source = makeSource(true);
      source.start();

      // Act - advance well past a single loop.
      vi.advanceTimersByTime(1_000_000);
      const afterOne = transcripts.length;
      vi.advanceTimersByTime(1_000_000);

      // Assert - still emitting, and a timer is always armed for the next event.
      expect(afterOne).toBeGreaterThan(0);
      expect(transcripts.length).toBeGreaterThan(afterOne);
      expect(vi.getTimerCount()).toBe(1);

      source.stop();
    });

    it('stops emitting after stop()', () => {
      // Arrange
      const source = makeSource(true);
      source.start();
      vi.advanceTimersByTime(600);
      const count = transcripts.length;

      // Act
      source.stop();
      vi.advanceTimersByTime(1_000_000);

      // Assert
      expect(transcripts).toHaveLength(count);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
