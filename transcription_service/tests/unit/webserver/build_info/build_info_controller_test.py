"""
Unit tests for reading the build provenance stamped into the image
"""

import pytest

from src.webserver.features.build_info import UNKNOWN, read_build_info


def test_reads_every_field_a_ci_build_bakes_in():
    """
    A fully stamped CI image reports every field it was given
    """
    env = {
        "SCRIBEAR_BUILD_SERVICE": "transcription-service",
        "SCRIBEAR_BUILD_VERSION": "0.2.0",
        "SCRIBEAR_BUILD_COMMIT": "def6e68f0b3c4a1d9e2f5a7b8c0d1e2f3a4b5c6d",
        "SCRIBEAR_BUILD_REF": "staging",
        "SCRIBEAR_BUILD_TIME": "2026-07-24T12:03:11Z",
        "SCRIBEAR_BUILD_TAGS": "staging,staging-def6e68",
        "SCRIBEAR_BUILD_ORIGIN": "ci",
    }

    assert read_build_info(env).to_json() == {
        "service": "transcription-service",
        "version": "0.2.0",
        "commit": "def6e68f0b3c4a1d9e2f5a7b8c0d1e2f3a4b5c6d",
        "ref": "staging",
        "builtAt": "2026-07-24T12:03:11Z",
        "imageTags": ["staging", "staging-def6e68"],
        "pullRequest": None,
        "origin": "ci",
        "dirty": False,
    }


def test_reports_origin_unknown_when_nothing_stamped_the_build():
    """
    A service started straight from a checkout has no image and stamps nothing

    It must still describe itself, and must do so in a way the console can
    distinguish from a probe that failed - hence UNKNOWN rather than empty
    strings, and an origin of "unknown" rather than "local".
    """
    assert read_build_info({"SCRIBEAR_BUILD_VERSION": "   "}).to_json() == {
        "service": UNKNOWN,
        "version": UNKNOWN,
        "commit": UNKNOWN,
        "ref": UNKNOWN,
        "builtAt": UNKNOWN,
        "imageTags": [],
        "pullRequest": None,
        "origin": UNKNOWN,
        "dirty": False,
    }


def test_splits_a_dirty_suffix_out_of_the_commit():
    """
    The -dirty suffix rides on the commit so docker inspect carries it too

    It is split back out here so the console can flag an image built from a
    modified working tree without string-matching.
    """
    info = read_build_info(
        {
            "SCRIBEAR_BUILD_COMMIT": "def6e68-dirty",
            "SCRIBEAR_BUILD_ORIGIN": "local",
        }
    )

    assert info.commit == "def6e68"
    assert info.dirty is True
    assert info.origin == "local"


def test_reads_the_pull_request_a_pr_build_came_from():
    """
    A PR build reports the PR number as a number, for a "PR #157" chip
    """
    assert read_build_info({"SCRIBEAR_BUILD_PR": "157"}).pull_request == 157


@pytest.mark.parametrize("raw", ["", "   ", "abc", "0", "-3", "1.5"])
def test_reports_no_pull_request_for_unparseable_values(raw: str):
    """
    Every non-PR build passes this variable empty, so empty is the common case
    """
    assert read_build_info({"SCRIBEAR_BUILD_PR": raw}).pull_request is None


def test_splits_trims_and_drops_empty_image_tags():
    """
    Tags arrive comma-joined because a --build-arg cannot be an array
    """
    info = read_build_info({"SCRIBEAR_BUILD_TAGS": " latest , , v0.2.0 "})

    assert info.image_tags == ["latest", "v0.2.0"]


def test_treats_an_unrecognized_origin_as_unknown():
    """
    Only the two origins the build system stamps are accepted
    """
    assert (
        read_build_info({"SCRIBEAR_BUILD_ORIGIN": "jenkins"}).origin == UNKNOWN
    )
