"""
Unit tests for NPCircularBuffer
"""

import numpy as np
import pytest

from src.shared.utils.np_circular_buffer import NPCircularBuffer


@pytest.fixture
def buffer():
    """
    Create a new circular buffer for each test
    """
    return NPCircularBuffer(10, int)


def test_single_element_append(buffer: NPCircularBuffer):
    """
    Tests appending one element to buffer
    """
    # Arrange / Act
    remaining = buffer.append(np.array([1]))

    # Assert
    assert np.array_equal(remaining, np.array([]))
    assert np.array_equal(buffer.get(), np.array([1]))
    assert len(buffer) == 1


def test_multi_element_append(buffer: NPCircularBuffer):
    """
    Tests appending many elements to buffer
    """
    # Arrange
    arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

    # Act
    remaining = buffer.append(np.array(arr))

    # Assert
    assert np.array_equal(remaining, np.array([]))
    assert np.array_equal(buffer.get(), np.array(arr))
    assert len(buffer) == 10


def test_single_element_append_when_full(buffer: NPCircularBuffer):
    """
    Tests appending one element to buffer when buffer is full
    """
    # Arrange
    arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    buffer.append(np.array(arr))

    # Act
    remaining = buffer.append(np.array([1]))

    # Assert
    assert np.array_equal(remaining, np.array([1]))
    assert np.array_equal(buffer.get(), np.array(arr))
    assert len(buffer) == 10


def test_muti_element_append_when_full(buffer: NPCircularBuffer):
    """
    Tests appending many element to buffer when buffer is full
    """
    # Arrange
    arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    append = [10, 11, 12, 13, 14]
    buffer.append(np.array(arr))

    # Act
    remaining = buffer.append(np.array(append))

    # Assert
    assert np.array_equal(remaining, np.array(append))
    assert np.array_equal(buffer.get(), np.array(arr))
    assert len(buffer) == 10


def test_muti_element_append_when_almost_full(buffer: NPCircularBuffer):
    """
    Tests appending many elements to buffer when buffer is almost full and
    a subset of appended array should be returned
    """
    # Arrange
    arr = [0, 1, 2, 3, 4, 5, 6, 7, 8]
    append = [9, 10, 11]
    buffer.append(np.array(arr))

    # Act
    remaining = buffer.append(np.array(append))

    # Assert
    assert np.array_equal(remaining, np.array([10, 11]))
    assert np.array_equal(
        buffer.get(), np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    )
    assert len(buffer) == 10


def test_purge_single_element(buffer: NPCircularBuffer):
    """
    Test purging a single element from buffer
    """
    # Arrange
    buffer.append(np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))

    # Act
    buffer.purge(1)

    # Assert
    assert np.array_equal(buffer.get(), np.array([1, 2, 3, 4, 5, 6, 7, 8, 9]))
    assert len(buffer) == 9


def test_purge_multiple_elements(buffer: NPCircularBuffer):
    """
    Test purging many elements from buffer
    """
    # Arrange
    buffer.append(np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))

    # Act
    buffer.purge(5)

    # Assert
    assert np.array_equal(buffer.get(), np.array([5, 6, 7, 8, 9]))
    assert len(buffer) == 5


def test_purge_all_elements(buffer: NPCircularBuffer):
    """
    Test purging all elements from buffer
    """
    # Arrange
    buffer.append(np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))

    # Act
    buffer.purge(10)

    # Assert
    assert np.array_equal(buffer.get(), np.array([]))
    assert len(buffer) == 0


def test_append_after_purge_sequence(buffer: NPCircularBuffer):
    """
    Test insertion after purging buffer
    """
    # Arrange
    buffer.append(np.array([0, 1, 2, 3, 4]))
    buffer.append(np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))

    # Act
    buffer.purge(5)
    buffer.append(np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))

    # Assert
    assert np.array_equal(
        buffer.get(), np.array([0, 1, 2, 3, 4, 0, 1, 2, 3, 4])
    )
    assert len(buffer) == 10
