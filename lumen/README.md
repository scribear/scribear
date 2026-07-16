# Lumen Granite Speech — quick test

A throwaway spike to figure out how to talk to NCSA **Lumen**'s
`granite-speech-4.1-2b-plus` model, so we can decide how to wire it in as a
new ScribeAR transcription server (see
[How to Create a New Transcription Service](../scribear.wiki/How%20to%20Create%20a%20New%20Transcription%20Service.md),
**Recipe B — remote OpenAI-like server**).

## TL;DR findings

| Question | Answer |
|---|---|
| API style | **OpenAI-compatible.** Standard `POST /v1/audio/transcriptions`, multipart upload. The stock `openai` Python SDK works by just setting `base_url`. |
| Model id | `granite-speech-4.1-2b-plus` (input modality: `audio`, `max_model_len` 4096) |
| Auth | `Authorization: Bearer $LUMEN_API_KEY` |
| Response | `{"text": "...", "usage": {"seconds": N, "type": "duration"}}` |
| **True streaming?** | **No.** `stream=true` is accepted but ignored — the server returns one `application/json` body for the whole upload (Content-Type is `application/json`, not `text/event-stream`). No SSE / token deltas. |
| `verbose_json` | **Not supported** → no word/segment timestamps. Only `json` (`{"text":...}`). |
| Audio format | Anything ffmpeg-decodable server-side; we tested **16 kHz mono 16-bit WAV** (Granite's native rate). Multi-channel/48 kHz WAV also accepted. |
| Latency | Fast: ~0.3–0.5 s per request in this test, even re-sending a growing ~50 s buffer. |
| Quality | Accurate on real speech. Non-speech audio (the repo's `test_audio_files/musical_chords`) hallucinates `"Thank you"` — expected. |
| **Speaker-Attributed ASR (card Task 2)** | **Not reachable via Lumen today** — but works on other hosting of the *same model*. The byte-identical known-working request (see below) returns a plain transcript with no `[Speaker N]:` tags on Lumen. It's a Lumen serving-stack limitation, not a request-format issue. |
| Instruction prompts | The `prompt` param reaches the model but behaves like Whisper "context", not an instruction — it can suppress output but does not follow directives like speaker tagging or timestamps. |

**Implication for realtime captions:** because there's no true streaming
endpoint, live captions must use a **growing/sliding window** — buffer mic
audio and every ~N seconds re-POST the current buffer, surfacing the result
as an `in_progress` caption; finalize + purge stable audio. This is exactly
the pattern in the wiki's Recipe B (`openai_compatible_job` re-sends the
buffer each period and returns `in_progress`).

## Setup

```bash
cd lumen
cp .env.example .env        # then paste the real LUMEN_API_KEY
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

`.env` (already present here) holds the Lumen key/URL/model. It is gitignored.

## Run

```bash
# 1. Batch. DEFAULT = Speaker-Attributed ASR (card Task 2) on the multi-speaker clip.
./.venv/bin/python test_batch.py
./.venv/bin/python test_batch.py --plain                                    # plain transcript
./.venv/bin/python test_batch.py --plain ../test_audio_files/musical_chords/mono_f64le.wav  # non-speech -> "Thank you"

# 2. Pseudo-streaming: growing window, prints incremental captions + per-request latency
./.venv/bin/python test_streaming.py --period 3
```

## Task 2 — Speaker-Attributed ASR (SAA)

The model card documents SAA (transcription with `[Speaker 1]:` / `[Speaker 2]:`
tags) by **prompting** the model:

```python
SAA_PROMPT = "<|audio|> Speaker attribution: Transcribe and denote who is speaking by adding [Speaker 1]: and [Speaker 2]: tags before speaker turns."
saa_text = transcribe(audio.data, SAA_PROMPT)
for segment in re.split(r"(\[Speaker \d+\]:)", saa_text):
    print(segment.strip())
```

`test_batch.py` implements exactly this and runs it by default. **But against
the current Lumen endpoint it does not produce speaker tags** — verified from
several angles:

- `POST /audio/transcriptions` with the SAA prompt (with or without the
  `<|audio|>` token) returns the **identical plain transcript**, no tags. The
  `prompt` field is treated as Whisper-style context, not an instruction.
- The **byte-identical known-working request** from
  [`granite-speech-4.1-serve/scripts/test_plus_speakers.sh`](https://github.com/angrave/granite-speech-4.1-serve/blob/main/scripts/test_plus_speakers.sh)
  — same route, `--form-string "prompt=<|audio|> ..."`, both the speaker-only and
  the combined timestamp+speaker prompts — **returns speaker tags on that server
  but plain text on Lumen.** Same model, same request → different output, so the
  difference is the serving stack, not the request. (Corroborating detail: that
  server returns `usage.chunks`; Lumen returns `usage.seconds`.)
- `POST /chat/completions` with the audio as `input_audio` returns
  **HTTP 500 "Upstream error"** — the model advertises `input_modalities:
  ["audio"]` only, so the text+audio chat path isn't served either.

So the SAA code is correct and matches the known-working call. The blocker is
purely how Lumen serves the model: its transcription endpoint ignores the
instruction prompt. **Path forward:** either ask NCSA/Lumen to enable the
prompt-driven tasks (as `granite-speech-4.1-serve` does), point ScribeAR at a
`granite-speech-4.1-serve` deployment instead, or do speaker diarization on our
side. **This is the key open question to raise with the Lumen/NCSA team.**

## Files

| File | Purpose |
|---|---|
| `lumen_client.py` | Loads `.env`, returns an `openai` SDK client pointed at Lumen. |
| `test_batch.py` | Simplest end-to-end check: one file → one transcript. |
| `test_streaming.py` | Simulates live captions via a growing-window re-transcribe loop. |

Audio fixtures live in the shared [`../test_audio_files/`](../test_audio_files/) dir (see [`speech/source.txt`](../test_audio_files/speech/source.txt) for provenance):

| Fixture | Purpose |
|---|---|
| `speech/harvard_16k_mono.wav` | Single-speaker read speech (Harvard sentences) — meaningful output. |
| `speech/apollo11_dialogue_16k_mono.wav` | ~50 s multi-speaker mission dialogue (Apollo 11, public domain). |
| `musical_chords/mono_f64le.wav` | Synthetic sine-wave chords (non-speech smoke test → `"Thank you"`). |

## Raw endpoint (no SDK), for reference

```bash
set -a && . ./.env && set +a
curl -s -H "Authorization: Bearer $LUMEN_API_KEY" \
  -F "model=$LUMEN_GRANITE" \
  -F "file=@../test_audio_files/speech/harvard_16k_mono.wav" \
  "$LUMEN_BASE_URL/audio/transcriptions"
```

## Notes for integration

- Slots straight into **Recipe B** (`TranscriptionProviderUID.OPENAI_COMPATIBLE`)
  with `base_url = https://lumen.ncsa.illinois.edu/v1`,
  `request_path = /audio/transcriptions`, model `granite-speech-4.1-2b-plus`,
  and the key from an env var / secret. No local GPU, no new context enum needed.
- Since there are no timestamps and no server streaming, finalization logic
  (LocalAgree-style `final` vs `in_progress`) has to live on our side, driven by
  the windowed re-transcription — not by upstream segment boundaries.
- The model reports `max_model_len` 4096. A 51 s window transcribed fine in one
  request here, so that's not an obvious hard audio cap — but for live use,
  purge finalized audio and keep windows bounded rather than growing forever.
