import { afterEach, beforeEach, describe, expect } from 'vitest';

import { AppConfig } from '#src/app-config/app-config.js';
import { DEFAULT_THRESHOLDS } from '#src/server/shared/alerts/alert-rules.js';

/**
 * The flat-override-wins logic lives in `AppConfig.alertThresholds`: when
 * `ALERT_ASR_DUTY_RATIO` is set, it populates both `asrDutyRatio` and
 * `asrDutyRatioCpu` with that value, so the device-aware selection in the
 * alert rule is a no-op. This is the path most likely to regress for
 * deployments already setting `MONITORING_ASR_DUTY_RATIO`.
 */

const REQUIRED_ENV = {
  LOG_LEVEL: 'silent',
  PORT: '0',
  HOST: '127.0.0.1',
} as const;

describe('AppConfig.alertThresholds — per-device duty ratio', (it) => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    Object.assign(process.env, REQUIRED_ENV);
    delete process.env['ALERT_ASR_DUTY_RATIO'];
    delete process.env['ALERT_ASR_DUTY_RATIO_CPU'];
  });

  afterEach(() => {
    process.env = saved;
  });

  it('uses the compiled defaults when neither override is set', () => {
    const config = new AppConfig();
    const thresholds = config.alertThresholds;

    expect(thresholds.asrDutyRatio).toBe(DEFAULT_THRESHOLDS.asrDutyRatio);
    expect(thresholds.asrDutyRatioCpu).toBe(DEFAULT_THRESHOLDS.asrDutyRatioCpu);
  });

  it('a flat ALERT_ASR_DUTY_RATIO override wins over both per-device defaults', () => {
    process.env['ALERT_ASR_DUTY_RATIO'] = '0.9';
    const config = new AppConfig();
    const thresholds = config.alertThresholds;

    expect(thresholds.asrDutyRatio).toBe(0.9);
    // Both must be the same so the device-aware selection is a no-op.
    expect(thresholds.asrDutyRatioCpu).toBe(0.9);
  });

  it('ALERT_ASR_DUTY_RATIO_CPU overrides only the CPU default', () => {
    process.env['ALERT_ASR_DUTY_RATIO_CPU'] = '0.6';
    const config = new AppConfig();
    const thresholds = config.alertThresholds;

    expect(thresholds.asrDutyRatio).toBe(DEFAULT_THRESHOLDS.asrDutyRatio);
    expect(thresholds.asrDutyRatioCpu).toBe(0.6);
  });

  it('a flat override wins over a per-device override', () => {
    process.env['ALERT_ASR_DUTY_RATIO'] = '0.8';
    process.env['ALERT_ASR_DUTY_RATIO_CPU'] = '0.6';
    const config = new AppConfig();
    const thresholds = config.alertThresholds;

    expect(thresholds.asrDutyRatio).toBe(0.8);
    expect(thresholds.asrDutyRatioCpu).toBe(0.8);
  });
});
