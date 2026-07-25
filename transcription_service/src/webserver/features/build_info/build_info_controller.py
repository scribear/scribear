"""
Reads the build provenance the image was stamped with
"""

import os
import re
from dataclasses import dataclass, field
from typing import Optional

# Stand-in for a field the build did not supply. A literal rather than an empty
# string or null so that an unstamped image reads as "built outside CI"
# everywhere it is displayed, instead of as a blank cell that could equally
# mean the request failed. Matches the Node reader in
# libs/base-fastify-server/src/server/build-info.ts.
UNKNOWN = "unknown"

# Suffix appended to the commit when the working tree had uncommitted changes,
# following the `git describe --dirty` convention. Carried in the commit string
# rather than in a variable of its own so that
# `org.opencontainers.image.revision` - which an operator reads with
# `docker inspect`, far from this code - says so too.
DIRTY_SUFFIX = "-dirty"

_ORIGINS = ("ci", "local")
_DIGITS = re.compile(r"^\d+$")


@dataclass(frozen=True)
class BuildInfo:
    """
    What this container can say about the artifact it was built from

    The same shape every other container in the stack reports, so the admin
    console's Deployment Check renders one table rather than one renderer per
    language.
    """

    service: str
    version: str
    commit: str
    ref: str
    built_at: str
    image_tags: list[str] = field(default_factory=list)
    pull_request: Optional[int] = None
    origin: str = UNKNOWN
    dirty: bool = False

    def to_json(self) -> dict:
        """
        Serializes to the stack's shared build-info document

        Keys are camelCase because this crosses a language boundary and the
        consumer is TypeScript; the field names above stay snake_case because
        this side is Python.

        Returns:
            dict ready to be returned from the /build-info route
        """
        return {
            "service": self.service,
            "version": self.version,
            "commit": self.commit,
            "ref": self.ref,
            "builtAt": self.built_at,
            "imageTags": self.image_tags,
            "pullRequest": self.pull_request,
            "origin": self.origin,
            "dirty": self.dirty,
        }


def _field(value: Optional[str]) -> str:
    """
    Normalizes one stamped value, defaulting a missing or blank one

    Args:
        value - Raw environment value, possibly absent

    Returns:
        The trimmed value, or UNKNOWN
    """
    trimmed = (value or "").strip()
    return trimmed or UNKNOWN


def _pull_request(value: Optional[str]) -> Optional[int]:
    """
    Parses the pull request number a PR build was stamped with

    Anything unparseable is None rather than an error: this is decoration on a
    page whose job is to work when the deployment does not. Every non-PR build
    passes the variable empty, so the empty case is the common one.

    Args:
        value - Raw environment value, possibly absent

    Returns:
        Positive PR number, or None
    """
    trimmed = (value or "").strip()
    if not _DIGITS.match(trimmed):
        return None
    parsed = int(trimmed)
    return parsed if parsed > 0 else None


def read_build_info(env: Optional[dict] = None) -> BuildInfo:
    """
    Reads the SCRIBEAR_BUILD_* variables the Dockerfile baked in

    Tolerant by construction - every field falls back to UNKNOWN rather than
    raising. This answers an operator's "what is deployed?" question, and a
    container that cannot describe itself must still start and still answer, or
    the one situation the page exists for (a half-finished upgrade) is also the
    situation where it goes blank.

    Args:
        env - Environment to read; defaults to the process environment

    Returns:
        BuildInfo
    """
    source = os.environ if env is None else env

    raw_commit = _field(source.get("SCRIBEAR_BUILD_COMMIT"))
    dirty = raw_commit.endswith(DIRTY_SUFFIX)
    commit = raw_commit[: -len(DIRTY_SUFFIX)] if dirty else raw_commit

    origin = (source.get("SCRIBEAR_BUILD_ORIGIN") or "").strip().lower()

    tags = [
        tag.strip()
        for tag in (source.get("SCRIBEAR_BUILD_TAGS") or "").split(",")
        if tag.strip()
    ]

    return BuildInfo(
        service=_field(source.get("SCRIBEAR_BUILD_SERVICE")),
        version=_field(source.get("SCRIBEAR_BUILD_VERSION")),
        commit=commit,
        ref=_field(source.get("SCRIBEAR_BUILD_REF")),
        built_at=_field(source.get("SCRIBEAR_BUILD_TIME")),
        image_tags=tags,
        pull_request=_pull_request(source.get("SCRIBEAR_BUILD_PR")),
        origin=origin if origin in _ORIGINS else UNKNOWN,
        dirty=dirty,
    )
