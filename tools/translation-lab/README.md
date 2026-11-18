# Browser Translation Lab

Standalone browser page for testing the real ScribeAR Bergamot translation
pipeline without a ScribeAR session, Whisper server, WebSocket, or Redux UI.

## Start

From the repository root:

```bash
npm run translation:lab
```

Then open:

```text
http://127.0.0.1:4173/
```

The command copies the pinned Bergamot Worker/WASM assets and starts Vite with
a same-origin proxy for Mozilla's public model registry and model files.

## Test modes

1. Manual English text.
2. Four repeatable text cases covering normal speech, numbers, punctuation,
   URLs, and email addresses.
3. Simulated finalized live-caption fragments.
4. Microphone transcription through the browser Web Speech API.

The microphone test defaults to `processLocally = true`. When the browser
supports the on-device SpeechRecognition model API, the page checks and, after
a user click, installs the `en-US` dictation language pack. Unchecking the
local-only option allows the browser's default recognition service, which may
send audio to a vendor service.

Translation remains local in both modes. Only Mozilla language model files are
downloaded through `/mozilla-models`; input text is sent directly to the local
Bergamot Worker and Marian WASM runtime.
