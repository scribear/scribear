"""
Defines EventEmitter and related classes for managing events and their subscribers.
"""

from typing import Any, Callable, Generic, List, ParamSpec

# Type variable to capture the argument types of a callable.
P = ParamSpec("P")


class Event(Generic[P]):
    """
    Defines an event by linking an event name to a specific callback signature.
    Used for type checking.

    Usage:
    ```
    # Defines an event in which callback has positional and
    # keyword arguments defined by dummy_callback
    def dummy_callback(num: int, msg: str, key: str = "", val: int = 0):
        pass
    kwarg_event = Event("kwarg", callback_type=dummy_callback)

    # Shorthand for defining a callback with only positional arguments
    arg_event = Event[[str, int]]("arg")
    ```
    """

    def __init__(
        self, name: str, callback_type: Callable[P, Any] | None = None
    ):
        # pylint: disable=unused-argument
        self.name = name


class _CallbackWrapper(Generic[P]):
    """
    Wraps a callback function with metadata used by event emitter
    """

    def __init__(self, callback: Callable[P, Any], should_call_once: bool):
        """
        Args:
            callback            - function to call when event is fired
            should_call_once    - whether or not event listener should be removed
                                    after event is fired or not
        """
        self._callback = callback
        self.should_call_once = should_call_once

    def __call__(self, *args: P.args, **kwargs: P.kwargs) -> Any:
        self._callback(*args, **kwargs)

    def __eq__(self, other: Any):
        if isinstance(other, _CallbackWrapper):
            return other._callback == self._callback
        return False


class EventEmitter:
    """
    Class to manage events and their subscribers.

    When an event is emitted, EventEmitter calls all callbacks
    registered for that event with the provided arguments.

    Usage:
    ```
    # Define an event and its callback signature
    arg_event = Event[[str, int]]("arg")

    ee = EventEmitter()

    # Listen for event
    def cb(foo: str, bar: int):
        print("cb()", foo, bar)
    ee.on(arg_event, cb)

    # Emit event
    ee.emit(arg_event, "hi", 10) # prints: cb() hi 10
    ```
    """

    def __init__(self):
        self._listeners: dict[str, List[_CallbackWrapper[...]]] = {}

    def on(self, event: Event[P], callback: Callable[P, Any]):
        """
        Register a callback for a specific event.
        Callback function must match ParamSpec linked with given Event.

        Args:
            event       - Event for which provided callback should be called
            callback    - Function that should be called when event is emitted
        """
        if event.name not in self._listeners:
            self._listeners[event.name] = []
        self._listeners[event.name].append(_CallbackWrapper(callback, False))

    def once(self, event: Event[P], callback: Callable[P, Any]):
        """
        Register a callback for a specific event that will only be called once.
        Callback function must match ParamSpec linked with given Event.

        Args:
            event       - Event for which provided callback should be called
            callback    - Function that should be called when event is emitted
        """
        if event.name not in self._listeners:
            self._listeners[event.name] = []
        self._listeners[event.name].append(_CallbackWrapper(callback, True))
        return self

    def emit(self, event: Event[P], *args: P.args, **kwargs: P.kwargs):
        """
        Triggers all registered callbacks for given event with the given arguments.

        Args:
            event       - Event to emit
            args        - Positional arguments to pass to function
            kwargs      - Keyword arguments to pass to function
        """
        if event.name in self._listeners:
            to_remove: List[_CallbackWrapper[...]] = []
            for listener in self._listeners[event.name]:
                listener(*args, **kwargs)

                if listener.should_call_once:
                    to_remove.append(listener)

            for listener in to_remove:
                self._listeners[event.name].remove(listener)

    def remove_listener(self, event: Event[P], callback: Callable[P, Any]):
        """
        Removes a callback for given event.

        Args:
            event       - Event for which callback should be removed from
            callback    - Function that should be removed
        """
        if event.name in self._listeners:
            self._listeners[event.name].remove(
                _CallbackWrapper(callback, False)
            )

    def remove_all_listeners(self, event: Event[P] | None = None):
        """
        If event is given, removes all listeners for given event
        Otherwise, removes all listeners from all events

        Args:
            event       - Event for which to remove listeners from (optional)
        """
        if event:
            if event.name in self._listeners:
                del self._listeners[event.name]
        else:
            self._listeners = {}
