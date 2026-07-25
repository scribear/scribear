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
    const fragment = buildFragment('who are you', 0, 3, false);

    // Assert - leadingSpace: false suppresses the space on the first token
    expect(fragment.text).toStrictEqual(['who', ' are', ' you']);
    expect(fragment.text.join('')).toBe('who are you');
  });

  it('prefixes every token, including the first, with a space by default', () => {
    // Act - `leadingSpace` defaults to true, so this fragment can be safely
    // appended after prior finalized text with no separator.
    const fragment = buildFragment('who are', 0, 2);

    // Assert
    expect(fragment.text).toStrictEqual([' who', ' are']);
    expect(fragment.text.join('')).toBe(' who are');
  });

  it('emits per-token timings within the utterance window, aligned to text', () => {
    // Act
    const fragment = buildFragment('one two', 4, 6);

    // Assert
    expect(fragment.starts).toStrictEqual([4, 5]);
    expect(fragment.ends).toStrictEqual([5, 6]);
    expect(fragment.starts).toHaveLength(fragment.text.length);
    expect(fragment.ends).toHaveLength(fragment.text.length);
  });
});

describe('buildDemoSchedule', (it) => {
  it('emits a final with no interim for a line shorter than one interim interval', () => {
    // Arrange - "hello there" is 2 words; at 5 wps that's under 1s, so the
    // 1s duration floor applies and there's no room for an interim tick.
    const turns = [{ speaker: 'alice', lines: ['hello there'] }];

    // Act
    const { events } = buildDemoSchedule(turns);

    // Assert
    expect(events).toHaveLength(1);
    expect(events[0]?.atMs).toBe(1000); // the 1s duration floor
    expect(events[0]?.message.final?.text.join('')).toBe('hello there');
    expect(events[0]?.message.inProgress).toBeNull();
  });

  it('emits growing-prefix interims roughly every second for a longer line', () => {
    // Arrange - 15 words at 5 wps = 3s, so two interim ticks (t=1, t=2) then
    // a final at t=3.
    const words = Array.from({ length: 15 }, (_, i) => `w${i}`);
    const turns = [{ speaker: 'alice', lines: [words.join(' ')] }];

    // Act
    const { events } = buildDemoSchedule(turns);

    // Assert
    expect(events.map((e) => e.atMs)).toStrictEqual([1000, 2000, 3000]);
    expect(events[0]?.message.inProgress).not.toBeNull();
    expect(events[1]?.message.inProgress).not.toBeNull();
    expect(events[2]?.message.final).not.toBeNull();
    expect(events[2]?.message.inProgress).toBeNull();

    // The interim text is a strict, growing prefix of the final text.
    const finalText = events[2]?.message.final?.text.join('').trim();
    const firstInterim = events[0]?.message.inProgress?.text.join('').trim();
    const secondInterim = events[1]?.message.inProgress?.text.join('').trim();
    expect(finalText?.startsWith(firstInterim ?? '')).toBe(true);
    expect(finalText?.startsWith(secondInterim ?? '')).toBe(true);
    expect((secondInterim?.length ?? 0) >= (firstInterim?.length ?? 0)).toBe(
      true,
    );
  });

  it('never puts a speaker label in caption text', () => {
    // Arrange
    const turns = [
      { speaker: 'alice', lines: ['a'] },
      { speaker: 'caterpillar', lines: ['b'] },
    ];

    // Act
    const finals = buildDemoSchedule(turns).events.map((e) =>
      e.message.final?.text.join('').trim(),
    );

    // Assert - speaker identity is a schedule-time concern only; it never
    // rides along in the wire text (the wire schema has no speaker field).
    expect(finals).toStrictEqual(['a', 'b']);
  });

  it('separates consecutive finals with a leading space so they never run together', () => {
    // Arrange - two short lines back to back (same turn, then a new turn).
    const turns = [
      { speaker: 'alice', lines: ['since then'] },
      { speaker: 'alice', lines: ['and so'] },
    ];

    // Act
    const { events } = buildDemoSchedule(turns);
    const joined = events.map((e) => e.message.final?.text.join('')).join('');

    // Assert - concatenating every final back-to-back (as the client does)
    // never merges two words across a boundary.
    expect(joined).toBe('since then and so');
  });

  it('does not prefix a leading space on the very first fragment of the loop', () => {
    // Arrange
    const turns = [{ speaker: 'alice', lines: ['first'] }];

    // Act
    const { events } = buildDemoSchedule(turns);

    // Assert
    expect(events[0]?.message.final?.text[0]).toBe('first');
  });

  it('orders events by time and derives loop length from the last event', () => {
    // Arrange
    const turns = [
      { speaker: 'alice', lines: ['x'] },
      { speaker: 'alice', lines: ['y'] },
    ];

    // Act
    const { events, loopMs } = buildDemoSchedule(turns);

    // Assert - monotonic non-decreasing atMs; loopMs is last end + tail gap.
    // "x": 1s (floor) + 0.8s between-turn gap + "y": 1s (floor) = 2.8s.
    const times = events.map((e) => e.atMs);
    expect(times).toStrictEqual([...times].sort((a, b) => a - b));
    expect(loopMs).toBe(2800 + 2000);
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

    it('publishes the first caption within the first second', () => {
      // Arrange
      makeSource(true).start();

      // Act
      vi.advanceTimersByTime(1_000);

      // Assert
      expect(transcripts.length).toBeGreaterThan(0);
      expect(
        transcripts[0]?.final !== null || transcripts[0]?.inProgress !== null,
      ).toBe(true);
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
      vi.advanceTimersByTime(1_000);
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
