"""
Shared pytest configuration for the transcription service test suite.
"""

import freezegun

# freeze_time() walks the attributes of every imported module to patch their
# datetime references. Heavy ML dependencies pulled in transitively by the
# transcription providers expose lazy module attributes (e.g. huggingface_hub)
# that trigger slow submodule imports when walked, which can blow the per-test
# timeout. Tell freezegun to skip them - tests that use freeze_time never rely
# on these modules' clocks.
freezegun.configure(
    extend_ignore_list=[
        "torch",
        "faster_whisper",
        "huggingface_hub",
        "transformers",
        "ctranslate2",
        "tokenizers",
    ]
)
