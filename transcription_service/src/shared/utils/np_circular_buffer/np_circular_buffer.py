"""
A utility class for buffering numpy arrays
"""

from typing import Any

import numpy as np
import numpy.typing as npt


class NPCircularBuffer:
    """
    An implementation of a fixed length circular buffer numpy array.
    """

    def __init__(self, max_size: int, dtype: npt.DTypeLike = int):
        """
        Args:
            max_size    - Maximum number of elements circular buffer should hold
            dtype       - Data type of elements to place in buffer
        """
        self._curr_size = 0
        self._max_size = max_size
        self._buffer = np.empty(self._max_size, dtype=dtype)

    def append(self, sequence: npt.NDArray[Any]) -> npt.NDArray[Any]:
        """
        Append a sequence to the end of the circular buffer.
        Attempts to append as many elements as possible, returns elements that were not appended.

        Args:
            sequence    - Numpy array to append to buffer

        Returns:
            Numpy array containing elements that were not appended in the same order as provided.
        """
        num_elements_to_append = len(sequence)
        space_available = self._max_size - self._curr_size

        if num_elements_to_append <= space_available:
            self._buffer[
                self._curr_size : self._curr_size + num_elements_to_append
            ] = sequence
            self._curr_size += num_elements_to_append
            return np.array([])

        if space_available > 0:
            self._buffer[self._curr_size :] = sequence[:space_available]

        self._curr_size = self._max_size
        return sequence[space_available:]

    def get(self):
        """
        Gets the current buffer

        Returns:
            A numpy view of the current elements in buffer
        """
        return self._buffer[: self._curr_size]

    def purge(self, amount: int):
        """
        Purges given number of elements from beginning of buffer

        Args:
            amount  - Number of elements to purge
        """
        amount = min(self._max_size, amount)
        self._buffer[: self._curr_size - amount] = self._buffer[
            amount : self._curr_size
        ]
        self._curr_size -= amount

    def __len__(self) -> int:
        """
        Returns:
            Length of current buffer
        """
        return self._curr_size
