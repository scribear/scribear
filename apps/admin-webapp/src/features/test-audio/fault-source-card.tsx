import { useState } from 'react';

import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';

import type {
  TestAudioFaultDevice,
  TestAudioFaultParams,
} from '#src/lib/admin-api';

import { DeviceCard } from './device-card';
import { ParamSlider } from './param-slider';
import {
  DEFAULT_DURATION_SEC,
  FAULT_KNOBS,
  formatKnobValue,
} from './params-meta';
import { isRunning, useDeviceRun } from './use-test-audio';

const SOURCE_NAME = 'fault source';

/**
 * Device 2 (§2.2): one knob per fault, all independently settable, each
 * captioned with what it is expected to trip.
 *
 * The captions are not decoration. §2.2 is a table of predictions the plan
 * itself says must not be taken on faith, and this page is where an operator
 * meets it — so the claim is printed against the knob that tests it, and the
 * ones that nothing currently measures say so.
 *
 * Draft-vs-poll behaviour is the same as the good source; see that card.
 */
export const FaultSourceCard = ({
  device,
  refresh,
}: {
  device: TestAudioFaultDevice;
  refresh: () => void;
}) => {
  const [draft, setDraft] = useState<TestAudioFaultParams | null>(null);
  const [durationSec, setDurationSec] = useState(DEFAULT_DURATION_SEC);
  const { busy, start, stop, retune } = useDeviceRun('fault', refresh);

  const params = draft ?? device.params;
  const running = isRunning(device);

  const change = (key: keyof TestAudioFaultParams, value: number) => {
    setDraft({ ...params, [key]: value });
    // Running: retune live rather than restart. Idle: local only, applied at
    // start.
    // Only the knob that moved, so the audit row names it (§3).
    if (running) retune({ [key]: value });
  };

  return (
    <DeviceCard
      device={device}
      title="Fault source"
      description="The same speech, damaged on demand. Every knob defaults to zero, so a run started untouched streams clean audio — turn on exactly the fault you came to see, or stack several to reproduce a report."
      sourceName={SOURCE_NAME}
      durationSec={durationSec}
      onDurationChange={setDurationSec}
      busy={busy}
      onStart={() => {
        start(params, durationSec);
      }}
      onStop={stop}
    >
      <Alert severity="info" sx={{ mb: 2 }}>
        Each caption below says what the fault is <em>expected</em> to show up
        as. They are predictions from the plan, checked against the alert rules
        and metric names in this repo — not measurements. Confirm on a live
        stack before quoting one in an incident.
      </Alert>
      <Stack spacing={2.5}>
        {FAULT_KNOBS.map((knob) => (
          <ParamSlider
            key={knob.key}
            label={knob.label}
            ariaLabel={`${knob.label} for the ${SOURCE_NAME}`}
            caption={knob.caption}
            value={params[knob.key]}
            min={knob.min}
            max={knob.max}
            step={knob.step}
            formatValue={(v) => formatKnobValue(knob, v)}
            onCommit={(v) => {
              change(knob.key, v);
            }}
          />
        ))}
      </Stack>
    </DeviceCard>
  );
};
