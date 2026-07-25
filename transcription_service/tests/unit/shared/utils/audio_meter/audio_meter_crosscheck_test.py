"""
PLAN-AUDIOVIZ §9 cross-check gate, publisher leg

`audio_meter_test.py` already gates this meter against tones it synthesizes
itself. This suite is different: it reads the *shared* expectation table in
`tools/audio-meter-crosscheck/fixtures.json`, the same table the standalone
meter page's DSP is held to, so the two surfaces an operator compares side by
side are pinned to one set of numbers rather than to two independently-written
ones.

Neither meter is the oracle. Every expectation is arithmetic - the RMS and peak
of the exact sample sequence each fixture defines - so a failure here means this
meter is wrong, not that it disagrees with its counterpart's opinion.

See `tools/audio-meter-crosscheck/README.md` for what this gate does and does
not cover; notably it stops at the DSP and does not exercise the live transport.
"""

import json
import wave
from pathlib import Path

import numpy as np
import pytest

from src.shared.utils.audio_meter import AudioLevelStats, AudioMeter


def _repo_root() -> Path:
    """
    Walks up to the directory holding both the fixture manifest and the WAV.

    The suite's working directory depends on where pytest was invoked from, so
    neither it nor a fixed number of `parent` hops is assumed.
    """
    for candidate in [
        Path(__file__).resolve(),
        *Path(__file__).resolve().parents,
    ]:
        if (candidate / "tools/audio-meter-crosscheck/fixtures.json").is_file():
            return candidate
    raise AssertionError(
        "Could not locate tools/audio-meter-crosscheck/fixtures.json above "
        f"{__file__}"
    )


REPO_ROOT = _repo_root()
FIXTURES = json.loads(
    (REPO_ROOT / "tools/audio-meter-crosscheck/fixtures.json").read_text(
        encoding="utf-8"
    )
)
TOLERANCE_DB = FIXTURES["toleranceDb"]


def _sine(fixture: dict) -> np.ndarray:
    """
    Generates a fixture's tone.

    A = 10^(dBFS/20) * sqrt(2), so the sine's RMS (A/sqrt(2)) lands on the
    requested level. Identical arithmetic to the JavaScript leg's `sineSamples`,
    so both meters see the same sample sequence.
    """
    total = round(fixture["seconds"] * fixture["sampleRate"])
    amplitude = 10 ** (fixture["rmsDbfs"] / 20) * np.sqrt(2)
    index = np.arange(total)
    return (
        amplitude
        * np.sin(
            2 * np.pi * fixture["frequencyHz"] * index / fixture["sampleRate"]
        )
    ).astype(np.float32)


def _wav_excerpt() -> tuple[int, np.ndarray]:
    """The fixture WAV's leading excerpt, as float32 in [-1, 1)."""
    spec = FIXTURES["wav"]
    with wave.open(str(REPO_ROOT / spec["path"])) as handle:
        assert handle.getnchannels() == 1, "fixture WAV must be mono"
        assert handle.getsampwidth() == 2, "fixture WAV must be 16-bit PCM"
        assert handle.getframerate() == spec["sampleRate"]
        raw = handle.readframes(handle.getnframes())

    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    assert len(samples) >= spec["sampleCount"]
    return spec["sampleRate"], samples[: spec["sampleCount"]]


def _snapshot(sample_rate: int, samples: np.ndarray) -> AudioLevelStats:
    """Feeds one full metering window and reads the meter."""
    seconds = len(samples) / sample_rate
    meter = AudioMeter(sample_rate=sample_rate, window_sec=seconds)
    meter.append(samples)
    snapshot = meter.snapshot()
    assert snapshot is not None
    return snapshot


class TestSharedToneFixtures:
    """Gate: the shared tone table, read within the shared tolerance."""

    @pytest.mark.parametrize(
        "fixture", FIXTURES["tones"], ids=[t["name"] for t in FIXTURES["tones"]]
    )
    def test_reads_tone_within_shared_tolerance(self, fixture):
        """Each shared tone's rms/peak dBFS agree with the arithmetic value."""
        # Arrange
        samples = _sine(fixture)

        # Act
        snapshot = _snapshot(fixture["sampleRate"], samples)

        # Assert - the same numbers the standalone page's DSP is held to.
        expected = fixture["expected"]
        assert abs(snapshot.rms_dbfs - expected["rmsDbfs"]) < TOLERANCE_DB
        assert abs(snapshot.peak_dbfs - expected["peakDbfs"]) < TOLERANCE_DB
        # clippingPct is absent for fixtures the two implementations disagree
        # about; those are pinned per-side in TestKnownDivergences instead.
        if "clippingPct" in expected:
            assert snapshot.clipping_pct == pytest.approx(
                expected["clippingPct"]
            )


class TestSharedWavFixture:
    """Gate: a known speech WAV, read within the shared tolerance."""

    def test_reads_excerpt_rms_within_shared_tolerance(self):
        """
        The excerpt's rms_dbfs matches its arithmetic RMS.

        This is the number the dashboard's meter bar renders, so it is the
        assertion that makes the two surfaces agree about what the operator
        sees.
        """
        # Arrange
        sample_rate, samples = _wav_excerpt()

        # Act
        snapshot = _snapshot(sample_rate, samples)

        # Assert
        expected = FIXTURES["wav"]["expected"]
        assert abs(snapshot.rms_dbfs - expected["rmsDbfs"]) < TOLERANCE_DB

    def test_reads_excerpt_peak_within_shared_tolerance(self):
        """The excerpt's peak_dbfs matches max|x| over the same samples."""
        # Arrange
        sample_rate, samples = _wav_excerpt()

        # Act
        snapshot = _snapshot(sample_rate, samples)

        # Assert - peak_dbfs is a window maximum. The page's comparable field is
        # `maxTruePeakDb`, not its hold-and-decay `peakDb`; see the JS leg.
        expected = FIXTURES["wav"]["expected"]
        assert abs(snapshot.peak_dbfs - expected["peakDbfs"]) < TOLERANCE_DB

    def test_reports_no_clipping_for_an_excerpt_that_has_none(self):
        """Real speech at -26 dBFS RMS charges nothing as clipping."""
        # Arrange
        sample_rate, samples = _wav_excerpt()

        # Act
        snapshot = _snapshot(sample_rate, samples)

        # Assert
        expected = FIXTURES["wav"]["expected"]
        assert snapshot.clipping_pct == pytest.approx(expected["clippingPct"])

    def test_real_speech_is_not_silence(self):
        """
        The excerpt must not read as silence.

        A cross-check that only compared levels could pass while the silence
        flag was inverted - and `silence` is what drives the dashboard's crit
        chip, so a wrong value here is a fleet-wide false alarm.
        """
        # Arrange
        sample_rate, samples = _wav_excerpt()

        # Act
        snapshot = _snapshot(sample_rate, samples)

        # Assert
        assert snapshot.silence is False


def _tone_fixture(name: str) -> dict:
    """Looks a tone fixture up by name, failing loudly if it was renamed."""
    for tone in FIXTURES["tones"]:
        if tone["name"] == name:
            return tone
    raise AssertionError(
        f"No tone fixture named {name!r} in the shared manifest"
    )


class TestKnownDivergences:
    """
    Pins this side of each documented cross-surface disagreement.

    A divergence that is merely written down rots. Asserting both sides means
    neither implementation can drift further without a test failing, and closing
    one requires updating the manifest deliberately rather than discovering the
    change later from a confused operator.
    """

    @pytest.mark.parametrize(
        "divergence",
        FIXTURES["knownDivergences"],
        ids=[d["name"] for d in FIXTURES["knownDivergences"]],
    )
    def test_publisher_side_of_the_divergence_is_unchanged(self, divergence):
        """
        This meter charges a full-scale sine as clipping; the page does not.

        Not a bug being asserted as correct - a disagreement being held still.
        The publisher counts any sample within CLIP_EPSILON of full scale with no
        run-length requirement, so audio that legitimately touches full scale
        reads as 12.5% clipped here and 0% on the standalone page. Changing it is
        a producer change, out of scope for PLAN-AUDIOVIZ (§11).
        """
        # Arrange
        fixture = _tone_fixture(divergence["fixture"])

        # Act
        snapshot = _snapshot(fixture["sampleRate"], _sine(fixture))

        # Assert
        assert snapshot.clipping_pct == pytest.approx(
            divergence["publisherClippingPct"]
        )
        # The dashboard's crit threshold is 1%, so this divergence is not
        # cosmetic: it is the difference between a red chip and a green one.
        assert snapshot.clipping_pct > 0.01
