import { describe, expect } from 'vitest';

import { parseJobPeriods } from '#src/server/shared/transcription-metrics/job-period-config.js';

describe('TRANSCRIPTION_JOB_PERIOD_MS parsing', () => {
  describe('per-provider periods', (it) => {
    it('keeps each provider’s own period', () => {
      // Arrange — the CUDA template's real shape: two providers, two periods,
      // in one deployment. A single global number cannot serve both, which is
      // why this variable is a map.
      const spec = 'whisper=500,lumen_granite=3000';

      // Act
      const { periods, errors } = parseJobPeriods(spec);

      // Assert
      expect(errors).toEqual([]);
      expect(periods.get('whisper')).toBe(500);
      expect(periods.get('lumen_granite')).toBe(3_000);
    });

    it('tolerates whitespace and trailing separators from hand-edited env files', () => {
      // Arrange
      const spec = ' whisper = 500 , crisper_whisper=500,\n';

      // Act
      const { periods, errors } = parseJobPeriods(spec);

      // Assert
      expect(errors).toEqual([]);
      expect([...periods]).toEqual([
        ['whisper', 500],
        ['crisper_whisper', 500],
      ]);
    });

    it('reads an unset variable as “no periods stated”, not as an error', () => {
      // Arrange — the default. The consequence is a missing series, which is the
      // honest answer when the denominator is unknown.
      // Act
      const { periods, errors } = parseJobPeriods('   ');

      // Assert
      expect(periods.size).toBe(0);
      expect(errors).toEqual([]);
    });
  });

  describe('rejections', (it) => {
    it('rejects a bare number rather than applying it to every provider', () => {
      // Arrange — the old format, and the bug: `1000` matched none of the three
      // periods the CUDA template configures, so the derived series was scaled
      // by 2x for whisper and 0.33x for lumen_granite with nothing to show it.
      // Act
      const { periods, errors } = parseJobPeriods('1000');

      // Assert — nothing is inherited from it, and the message names the fix.
      expect(periods.size).toBe(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('whisper=500,lumen_granite=3000');
    });

    it('rejects only the malformed entry, keeping the rest', () => {
      // Arrange — one typo must not cost the periods that were stated correctly;
      // the poller can still publish utilization for whisper.
      const spec = 'whisper=500,lumen_granite,=3000';

      // Act
      const { periods, errors } = parseJobPeriods(spec);

      // Assert — a period with no provider key names nothing and is dropped too.
      expect([...periods]).toEqual([['whisper', 500]]);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain('lumen_granite');
      expect(errors[1]).toContain('no provider key');
    });

    it('rejects a period that is not a positive number of milliseconds', () => {
      // Arrange — zero and empty both used to mean "disabled" by accident;
      // Number('') is 0, not NaN, so both paths need covering.
      // Act
      const { periods, errors } = parseJobPeriods(
        'whisper=0,lumen_granite=,debug=soon',
      );

      // Assert
      expect(periods.size).toBe(0);
      expect(errors).toHaveLength(3);
    });

    it('keeps the first of a duplicated provider and says so', () => {
      // Arrange — silently taking the last would make the effective period
      // depend on entry order.
      // Act
      const { periods, errors } = parseJobPeriods('whisper=500,whisper=3000');

      // Assert
      expect(periods.get('whisper')).toBe(500);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('twice');
    });
  });
});
