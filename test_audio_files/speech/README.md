# speech/

Real-speech test audio, for exercising transcription models (e.g. Lumen
Granite Speech) with meaningful spoken content. The `../musical_chords/`
fixtures are synthetic sine-wave chords and transcribe as noise/hallucination.

See [`source.txt`](source.txt) for upstream sources, licensing, and attribution.

## Files

| File | Content | Format |
|---|---|---|
| `harvard_16k_mono.wav` | Single speaker reading the Harvard sentences, from the Open Speech Repository (~34 s). | 16 kHz mono 16-bit PCM WAV |
| `apollo11_dialogue_16k_mono.wav` | Multi-speaker Apollo 11 mission dialogue — astronauts + Houston CAPCOM (~50 s). | 16 kHz mono 16-bit PCM WAV |

16 kHz mono is Granite Speech's native rate. Regeneration commands are in `source.txt`.
