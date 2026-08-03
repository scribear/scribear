"""
Defines the stage ids used by the per-stage audio telemetry graph

Constants only, and deliberately no imports: both sides of the
worker/main-process boundary name stages with these - a provider's job
declares which stage it measured and what fed it, the webserver's stream
controller declares the ingress stage and resolves the graph at publish time -
so the strings have to live somewhere neither side owns.

Stage ids are **not** a closed set. A provider may report a stage id not
listed here and it will be published and rendered like any other; these are
just the ones the shipped providers use, named once so a typo in one of them
cannot silently create a second, parallel stage on the dashboard. What makes
the graph work is `AudioStageReading.inputs`, not membership of this list.
"""

#: Audio as it arrives at the transcription stream websocket, before any
#: provider has seen it. Measured by the stream controller, so it exists for
#: every provider including ones that meter nothing themselves - which is the
#: point: "no audio reaching the service" is failure mode C1 and must not
#: depend on which ASR a deployment happens to run.
STAGE_INGRESS = "ingress"

#: Audio after the worker process has decoded it into the buffer the ASR reads
#: from. The gap between this and `STAGE_INGRESS` is audio the pipeline itself
#: lost - chunks dropped in the worker queue, decode failures, or a decode
#: batch whose tail the buffer had no room for
#: (`audio_dropped_buffer_full`). That last one only started showing up in
#: this gap once the overrun stopped being fatal: while it raised, the session
#: died on the spot and the job charged itself for the dropped samples anyway,
#: so the gap it was documented as measuring stayed at zero.
STAGE_ASR_INPUT = "asr_input"

#: The speech-gated subset of `STAGE_ASR_INPUT` that voice-activity detection
#: passed on to the ASR. Its own stage rather than a field on `asr_input`
#: because a deployment may run several detectors - one per ASR, or one shared
#: by all - and each needs to say what it was fed.
STAGE_VAD = "vad"
