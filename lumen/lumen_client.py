"""Shared Lumen client helpers.

Lumen (https://lumen.ncsa.illinois.edu) exposes an OpenAI-compatible API.
The `granite-speech-4.1-2b-plus` model is served behind the standard
OpenAI *audio transcription* route (`POST /v1/audio/transcriptions`,
multipart form upload), so we can talk to it with the stock `openai`
Python SDK by just pointing `base_url` at Lumen.

Env (see `.env`):
    LUMEN_API_KEY   - bearer token
    LUMEN_BASE_URL  - e.g. https://lumen.ncsa.illinois.edu/v1
    LUMEN_GRANITE   - model id, e.g. granite-speech-4.1-2b-plus
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))


def get_config() -> tuple[str, str, str]:
    """Return (api_key, base_url, model) from the environment, or raise."""
    api_key = os.environ.get("LUMEN_API_KEY")
    base_url = os.environ.get("LUMEN_BASE_URL")
    model = os.environ.get("LUMEN_GRANITE")
    missing = [
        name
        for name, val in (
            ("LUMEN_API_KEY", api_key),
            ("LUMEN_BASE_URL", base_url),
            ("LUMEN_GRANITE", model),
        )
        if not val
    ]
    if missing:
        raise SystemExit(f"Missing env var(s): {', '.join(missing)} (check lumen/.env)")
    return api_key, base_url, model  # type: ignore[return-value]


def get_client() -> tuple[OpenAI, str]:
    """Return an OpenAI SDK client pointed at Lumen, plus the model id."""
    api_key, base_url, model = get_config()
    return OpenAI(api_key=api_key, base_url=base_url), model


def transcribe(audio, prompt: str | None = None) -> str:
    """Transcribe `audio` (a path or a file-like object) and return the text.

    Mirrors the Granite model-card `transcribe(audio, prompt)` helper. Passing
    a `prompt` steers the model (e.g. the Speaker-Attributed ASR prompt).

    NOTE: against Lumen's hosted `/v1/audio/transcriptions` route the prompt is
    currently *not* honored for speaker attribution (see lumen/README.md) -- it
    returns a plain transcript regardless. The prompt path is kept faithful to
    the card so this works unchanged if/when SAA is exposed (chat route) or run
    against the model directly.
    """
    client, model = get_client()
    opened = None
    if isinstance(audio, str):
        opened = open(audio, "rb")  # noqa: SIM115 - closed in finally
        audio = opened
    try:
        kwargs = {"prompt": prompt} if prompt else {}
        resp = client.audio.transcriptions.create(
            model=model, file=audio, response_format="json", **kwargs
        )
        return resp.text
    finally:
        if opened is not None:
            opened.close()
