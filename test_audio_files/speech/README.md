# speech/

Real-speech test audio, for exercising transcription models (e.g. Lumen
Granite Speech) with meaningful spoken content. The `../musical_chords/`
fixtures are synthetic sine-wave chords and transcribe as noise/hallucination.

See [`source.txt`](source.txt) for upstream sources, licensing, and attribution.

## Files

| File | Content | Format |
|---|---|---|
| `harvard_16k_mono.wav` | Single speaker reading the Harvard sentences, from the Open Speech Repository (~34 s). | 16 kHz mono 16-bit PCM WAV |
| `harvard_16k_mono.txt` | Reference text for the above — IEEE list 1, as read. | UTF-8 text |
| `apollo11_dialogue_16k_mono.wav` | Multi-speaker Apollo 11 mission dialogue — astronauts + Houston CAPCOM (~50 s). | 16 kHz mono 16-bit PCM WAV |

16 kHz mono is Granite Speech's native rate. Regeneration commands are in `source.txt`.

## Reference transcripts

`harvard_16k_mono.txt` is the standard IEEE (1969) list 1 text, used by the
monitoring sidecar's synthetic canary as ground truth for its caption-accuracy
proxy. Two caveats:

- It is the *published* list text, not a transcription of this particular
  recording. Open Speech Repository recordings are typically preceded by a
  spoken announcement that is not in the reference. The canary scores word
  **recall** as its primary metric precisely because recall is unaffected by
  extra spoken words that the reference lacks.
- What matters operationally is the *delta from a known-good baseline* on this
  fixture, not the absolute score. Measure the baseline on a healthy
  deployment before tuning `ALERT_CANARY_MIN_RECALL`.

`apollo11_dialogue_16k_mono.wav` has no reference text; it is for manual
multi-speaker inspection rather than automated scoring.
