# Transcription WS Schema Mismatch Fix

## Problem

The Node server intermittently logged:

- `SchemaValidationError: Received message did not match expected server message schema.`

This happened while receiving transcription messages over the transcription-service websocket.

## Root Cause

There was a protocol mismatch between the runtime payload and the schema expected by Node:

- Node expected the newer wrapper format:
  - `type: "transcript"`
  - `final: { text, starts, ends } | null`
  - `in_progress: { text, starts, ends } | null`
- Some runtime messages still arrived in the legacy flat format:
  - `type: "ip_transcript"` or `type: "final_transcript"`
  - top-level `text`, `starts`, `ends`

Because websocket messages are schema-validated before they are emitted to downstream handlers, legacy payloads were rejected at the client boundary.

## Changes Made

1. Added compatibility normalization in `libs/clients/base-websocket-client/src/websocket-client.ts`.
   - `ip_transcript` is mapped to:
     - `type: "transcript"`
     - `final: null`
     - `in_progress: { text, starts, ends }`
   - `final_transcript` is mapped to:
     - `type: "transcript"`
     - `final: { text, starts, ends }`
     - `in_progress: null`
2. Validation now runs against the normalized payload.
3. Emitted `message` events use the normalized wrapper payload.
4. Added unit coverage in `libs/clients/base-websocket-client/tests/unit/create-websocket-client.test.ts` for `ip_transcript` normalization.

## Why This Fix Works

Downstream Node code already expects and uses wrapper fields (`final` and `in_progress`) in:

- `TranscriptionServiceManager` event forwarding
- `SessionStreamingController` websocket response payloads

Normalizing legacy messages at the websocket client boundary guarantees these fields are always present in the expected shape.

## Cleanup

All temporary debug logging blocks added during investigation were removed after validation.
