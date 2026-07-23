"""
Session-wide guards for freezegun's global clock patching.

freezegun installs itself by walking every module in sys.modules and rebinding
every reference it finds to datetime/time. Two properties of that sweep bite a
suite this size:

* It costs far more the first time it runs, because it builds a per-module
  attribute cache as it goes. With ~2000 modules imported by the end of
  collection, the first freeze_time() of a session takes ~25x as long as every
  later one - enough to blow the 1s default timeout on a loaded CI runner, on a
  test that does nothing but format one log line.

* It is process-global and is unwound only by the matching stop(). A timeout
  landing inside freeze_time.__enter__ therefore leaves time.monotonic() frozen
  for the rest of the session, and every later test that waits on the clock -
  the whole worker pool suite, every asyncio test - hangs until its own timeout.
  That turns one failure into dozens and reports a session lasting 12000 days.

pytest_collection_finish() pays the one-time cost before any test's timeout is
armed; the runtest hooks release a freeze that a test left running.
"""

import warnings
from datetime import datetime, timezone
from typing import Any, Iterator, List

import pytest
from freezegun import api as freezegun_api
from freezegun import freeze_time

# The guards below stand on freezegun internals: the freeze stack it unwinds
# and the two attributes stop() needs are not part of its public surface.
# pylint: disable=protected-access

# freezegun's cost is in the module sweep, not in the instant frozen, so any
# instant warms the cache.
WARMUP_INSTANT = datetime(2003, 7, 22, tzinfo=timezone.utc)

# Freezes whose start() has been entered, innermost last. Kept exactly as deep
# as freezegun's own freeze_factories stack.
STARTED_FREEZES: List[Any] = []

FREEZEGUN_START = freezegun_api._freeze_time.start
FREEZEGUN_STOP = freezegun_api._freeze_time.stop


def _tracked_start(self: Any) -> Any:
    """
    Record a freeze before it can be interrupted partway through installing
    itself, so an interrupted freeze can still be undone.
    """
    # stop() reads these two, but __init__ does not set them - start() does,
    # after it has already pushed onto freeze_factories. Seeding them keeps a
    # freeze interrupted inside that window undoable.
    self.fake_names = ()
    self.reals = {}

    STARTED_FREEZES.append(self)
    return FREEZEGUN_START(self)


def _tracked_stop(self: Any) -> None:
    """
    Undo a freeze, keeping the tracking stack in step with freezegun's own.
    """
    FREEZEGUN_STOP(self)
    del STARTED_FREEZES[len(freezegun_api.freeze_factories) :]


freezegun_api._freeze_time.start = _tracked_start
freezegun_api._freeze_time.stop = _tracked_stop


def _release_leaked_freezes(item: pytest.Item) -> None:
    """
    Unfreeze whatever the test left frozen, so one hung test cannot hang every
    test after it.
    """
    if not STARTED_FREEZES:
        return

    while STARTED_FREEZES and freezegun_api.freeze_factories:
        _tracked_stop(STARTED_FREEZES[-1])
    STARTED_FREEZES.clear()

    warnings.warn(
        f"{item.nodeid} left freezegun's clock frozen. It has been released so"
        " that the tests after it still see time advance.",
        stacklevel=1,
    )


def pytest_collection_finish() -> None:
    """
    Pay freezegun's one-time module sweep after collection has imported every
    test module, and before any test - and so any timeout - has started.
    """
    with freeze_time(WARMUP_INSTANT):
        pass


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item: pytest.Item) -> Iterator[None]:
    """
    Release a leaked freeze before the test's fixtures tear down, since a
    teardown that waits on the clock would otherwise hang too.
    """
    yield
    _release_leaked_freezes(item)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(item: pytest.Item) -> Iterator[None]:
    """
    Release a freeze leaked by a fixture's teardown.
    """
    yield
    _release_leaked_freezes(item)
